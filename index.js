const express = require('express');
const bodyParser = require('body-parser');
const login = require('ws3-fca');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- GLOBAL STATE ---
let botAPI = null;
let adminID = null;
let prefix = '/';
let botNickname = '─꯭─⃝AAHAN INSIIDE🤍🪽';

let lockedGroups = {};
let lockedNicknames = {};
let lockedGroupPhoto = {};
let fightSessions = {};
let joinedGroups = new Set();
let targetSessions = {};
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;
let currentCookies = null;
let reconnectAttempt = 0;
const signature = `\n                      ♦♦♦♦♦\n            ─꯭─⃝AAHAN INSIIDE🤍🪽`;
const separator = `\n---😏---💸---😈--🫰🏻---😈---🤒---`;

// --- UTILITY FUNCTIONS ---
function emitLog(message, isError = false) {
  const logMessage = `[${new Date().toISOString()}] ${isError ? '❌ ERROR: ' : '✅ INFO: '}${message}`;
  console.log(logMessage);
  io.emit('botlog', logMessage);
}

function saveCookies() {
  if (!botAPI) {
    emitLog('❌ Cannot save cookies: Bot API not initialized.', true);
    return;
  }
  try {
    const newAppState = botAPI.getAppState();
    const configToSave = {
      botNickname: botNickname,
      cookies: newAppState
    };
    fs.writeFileSync('config.json', JSON.stringify(configToSave, null, 2));
    currentCookies = newAppState;
    emitLog('✅ AppState saved successfully.');
  } catch (e) {
    emitLog('❌ Failed to save AppState: ' + e.message, true);
  }
}

// --- BOT INITIALIZATION AND RECONNECTION LOGIC ---
function initializeBot(cookies, prefix, adminID) {
  emitLog('🚀 Initializing bot with ws3-fca...');
  currentCookies = cookies;
  reconnectAttempt = 0;

  login({ appState: currentCookies }, (err, api) => {
    if (err) {
      emitLog(`❌ Login error: ${err.message}. Retrying in 10 seconds.`, true);
      setTimeout(() => initializeBot(currentCookies, prefix, adminID), 10000);
      return;
    }

    emitLog('✅ Bot successfully logged in.');
    botAPI = api;
    botAPI.setOptions({
      selfListen: true,
      listenEvents: true,
      updatePresence: false
    });

    // Pehle thread list update karein, phir baaki kaam
    updateJoinedGroups(api);

    // Thoda sa delay ke baad baaki functions call karein
    setTimeout(() => {
        setBotNicknamesInGroups();
        sendStartupMessage();
        startListening(api);
    }, 5000); // 5 seconds ka delay

    // Periodically save cookies every 10 minutes
    setInterval(saveCookies, 600000);
  });
}

function startListening(api) {
  api.listenMqtt(async (err, event) => {
    if (err) {
      emitLog(`❌ Listener error: ${err.message}. Attempting to reconnect...`, true);
      reconnectAndListen();
      return;
    }

    try {
      if (event.type === 'message' || event.type === 'message_reply') {
        await handleMessage(api, event);
      } else if (event.logMessageType === 'log:thread-name') {
        await handleThreadNameChange(api, event);
      } else if (event.logMessageType === 'log:user-nickname') {
        await handleNicknameChange(api, event);
      } else if (event.logMessageType === 'log:thread-image') {
        await handleGroupImageChange(api, event);
      } else if (event.logMessageType === 'log:subscribe') {
        await handleBotAddedToGroup(api, event);
      }
    } catch (e) {
      emitLog(`❌ Handler crashed: ${e.message}. Event: ${event.type}`, true);
    }
  });
}

function reconnectAndListen() {
  reconnectAttempt++;
  emitLog(`🔄 Reconnect attempt #${reconnectAttempt}...`, false);

  if (botAPI) {
    try {
      botAPI.stopListening();
    } catch (e) {
      emitLog(`❌ Failed to stop listener: ${e.message}`, true);
    }
  }

  if (reconnectAttempt > 5) {
    emitLog('❌ Maximum reconnect attempts reached. Restarting login process.', true);
    initializeBot(currentCookies, prefix, adminID);
  } else {
    setTimeout(() => {
      if (botAPI) {
        startListening(botAPI);
      } else {
        initializeBot(currentCookies, prefix, adminID);
      }
    }, 5000);
  }
}

async function setBotNicknamesInGroups() {
  if (!botAPI) return;
  try {
    const threads = await botAPI.getThreadList(100, null, ['GROUP']);
    const botID = botAPI.getCurrentUserID();
    for (const thread of threads) {
        try {
            const threadInfo = await botAPI.getThreadInfo(thread.threadID);
            if (threadInfo && threadInfo.nicknames && threadInfo.nicknames[botID] !== botNickname) {
                await botAPI.changeNickname(botNickname, thread.threadID, botID);
                emitLog(`✅ Bot's nickname set in group: ${thread.threadID}`);
            }
        } catch (e) {
            emitLog(`❌ Error setting nickname in group ${thread.threadID}: ${e.message}`, true);
        }
        await new Promise(resolve => setTimeout(resolve, 500)); // Thoda sa delay
    }
  } catch (e) {
    emitLog(`❌ Error getting thread list for nickname check: ${e.message}`, true);
  }
}

async function sendStartupMessage() {
  if (!botAPI) return;
  const startupMessage = `🖕🏻😈AAGYA AAGYA DIL CHURAANE MAIN AAGYA😈🖕🏻`;
  try {
    const threads = await botAPI.getThreadList(100, null, ['GROUP']);
    for (const thread of threads) {
        botAPI.sendMessage(startupMessage, thread.threadID)
          .catch(e => emitLog(`❌ Error sending startup message to ${thread.threadID}: ${e.message}`, true));
        await new Promise(resolve => setTimeout(resolve, 500)); // Thoda sa delay
    }
  } catch (e) {
    emitLog(`❌ Error getting thread list for startup message: ${e.message}`, true);
  }
}

async function updateJoinedGroups(api) {
  try {
    const threads = await api.getThreadList(100, null, ['GROUP']);
    joinedGroups = new Set(threads.map(t => t.threadID));
    emitGroups();
    emitLog('✅ Joined groups list updated successfully.');
  } catch (e) {
    emitLog('❌ Failed to update joined groups: ' + e.message, true);
  }
}

// --- WEB SERVER & DASHBOARD ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.post('/configure', (req, res) => {
  try {
    const cookies = JSON.parse(req.body.cookies);
    prefix = req.body.prefix || '/';
    adminID = req.body.adminID;

    if (!Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).send('Error: Invalid cookies format. Please provide a valid JSON array of cookies.');
    }
    if (!adminID) {
      return res.status(400).send('Error: Admin ID is required.');
    }

    res.send('Bot configured successfully! Starting...');
    initializeBot(cookies, prefix, adminID);
  } catch (e) {
    res.status(400).send('Error: Invalid configuration. Please check your input.');
    emitLog('Configuration error: ' + e.message, true);
  }
});

let loadedConfig = null;
try {
  if (fs.existsSync('config.json')) {
    loadedConfig = JSON.parse(fs.readFileSync('config.json'));
    if (loadedConfig.botNickname) {
      botNickname = loadedConfig.botNickname;
      emitLog('✅ Loaded bot nickname from config.json.');
    }
    if (loadedConfig.cookies && loadedConfig.cookies.length > 0) {
        emitLog('✅ Cookies found in config.json. Initializing bot automatically...');
        initializeBot(loadedConfig.cookies, prefix, adminID);
    } else {
        emitLog('❌ No cookies found in config.json. Please configure the bot using the dashboard.');
    }
  } else {
    emitLog('❌ No config.json found. You will need to configure the bot via the dashboard.');
  }
} catch (e) {
  emitLog('❌ Error loading config file: ' + e.message, true);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  emitLog(`✅ Server running on port ${PORT}`);
});

io.on('connection', (socket) => {
  emitLog('✅ Dashboard client connected');
  socket.emit('botlog', `Bot status: ${botAPI ? 'Started' : 'Not started'}`);
  socket.emit('groupsUpdate', Array.from(joinedGroups));
});

// The rest of the functions remain the same
// ... all your handle* functions go here (handleMessage, handleGroupCommand, etc.)

async function handleBotAddedToGroup(api, event) {
  const { threadID, logMessageData } = event;
  const botID = api.getCurrentUserID();

  if (logMessageData.addedParticipants.some(p => p.userFbId === botID)) {
    try {
      await api.changeNickname(botNickname, threadID, botID);
      await api.sendMessage(`🖕🏻😈LDKIYO KO LINE MAARNE WALA CHHERULAAL HU😈🖕🏻`, threadID);
      emitLog(`✅ Bot added to new group: ${threadID}. Sent welcome message and set nickname.`);
    } catch (e) {
      emitLog('❌ Error handling bot addition: ' + e.message, true);
    }
  }
}

function emitGroups() {
    io.emit('groupsUpdate', Array.from(joinedGroups));
}

// Updated helper function to format all messages
async function formatMessage(api, event, mainMessage) {
    const { senderID } = event;
    let senderName = 'User';
    try {
      const userInfo = await api.getUserInfo(senderID);
      senderName = userInfo && userInfo[senderID] && userInfo[senderID].name ? userInfo[senderID].name : 'User';
    } catch (e) {
      emitLog('❌ Error fetching user info: ' + e.message, true);
    }
    
    // Create the stylish, boxed-like mention text
    const styledMentionBody = `             [🦋°🫧•𖨆٭ ${senderName}꙳○𖨆°🦋]`;
    const fromIndex = styledMentionBody.indexOf(senderName);
    
    // Create the complete mention object
    const mentionObject = {
        tag: senderName,
        id: senderID,
        fromIndex: fromIndex
    };

    const finalMessage = `${styledMentionBody}\n${mainMessage}${signature}${separator}`;

    return {
        body: finalMessage,
        mentions: [mentionObject]
    };
}

async function handleMessage(api, event) {
  try {
    const { threadID, senderID, body, mentions } = event;
    const isAdmin = senderID === adminID;
    
    let replyMessage = '';
    let isReply = false;

    // First, check for mention of the admin
    if (Object.keys(mentions || {}).includes(adminID)) {
      const abuses = [
        "ADMIN KO BULAA RAHE HO LINE MAARNI HAI KYA!",
        "ADMIN NAHI RAJA JI BOLO!",
        "ADMIN KE TARAF MAT DEKHO USKO PYAAR HO JATA HAI!",
        "ADMIN NAHI BABU BOLO!"
      ];
      const randomAbuse = abuses[Math.floor(Math.random() * abuses.length)];
      
      const formattedAbuse = await formatMessage(api, event, randomAbuse);
      return await api.sendMessage(formattedAbuse, threadID);
    }

    // Now, check for commands and trigger words
    if (body) {
      const lowerCaseBody = body.toLowerCase();
      
       if (lowerCaseBody.includes('bot')) {
        replyMessage = `😼kya hua janeman kyun bula rahi ho🙄`;
        isReply = true;
      } else if (lowerCaseBody.includes('bot')) {
        replyMessage = `😼itne pyaar se na bolo mujhe kuchh kuchh hone lagta hai🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('bot')) {
        replyMessage = `😼baar baar mujhe tang na karo🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('bot')) {
        replyMessage = `😼kyu bulaa rahi ho mujhe🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('bot')) {
        replyMessage = `😼chumma doge kya mujhe itne pichhe pade ho🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('bot khana khaya')) {
        replyMessage = `😼are nahi main to bot hu main kaise khana khaunga 🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('bot kya kar rahe ho')) {
        replyMessage = `😼bas tumhe yaad kar raha hu baby🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('tum kaha rehte ho')) {
        replyMessage = `😼vaise to mujhe aahan ji ne bnaya but main aapke dil me rehta hu🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('kiss kar do')) {
        replyMessage = `😼ye lo meri baby puchuk puchuk 👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('kya kar rahe ho')) {
        replyMessage = `😼bas aapke khayaalo me kho raha hu aapse baat karke👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('jhuta')) {
        replyMessage = `😼are baby tumhaare laal laal liptick ki kasam mai sach bol rahi hu🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('le lo')) {
        replyMessage = `😼haaye daiyya kaisi baate kar rahe ho aap log mujhe saram aa rahi hai 🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('chumma doge')) {
        replyMessage = `😼haa baby bilkul dunga ye lo chummi ummah mela baby🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('maar dungi')) {
        replyMessage = `😼haaye baby jaan se kyun maarogii bas ek baar aankh maar do na 🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('gandu')) {
        replyMessage = `😼chhi chhi gaali de rahe hai yaar🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('chutiya')) {
        replyMessage = `😼gandii baat karta hai ye 🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('babu')) {
        replyMessage = `😼ufff aise na bolo main pat jaunga🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('mela bachcha')) {
        replyMessage = `😼bolo na baby🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('call aao')) {
        replyMessage = `😼main kaise call aaunga main to bot hu🙄👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('bot')) {
        replyMessage = `😼line maar rahi ho kya🙄👈🏻`;
        isReply = true;
      } else if (lowerCaseBody.includes('madharchod')) {
        replyMessage = `🙄GAALI NA DO NAHI TO PEL DUNGA🙄👈🏻`;
        isReply = true;
      } else if (lowerCaseBody.includes('bhag')) {
        replyMessage = `😼chala ja yahan se nahin to gaand pe laat maarunga🙄👈🏻 `;
        isReply = true;
      } else if (lowerCaseBody.includes('bot shayari sunao')) {
        replyMessage = `😼बदल जाओ वक्त के साथ
या फिर वक्त बदलना सीखो
मजबूरियों को मत कोसो
हर हाल में चलना सीखो  😼👈🏻`;
        isReply = true;
        } else if (lowerCaseBody.includes('ek aur)) {
        replyMessage = `😼सुना है आज समंदर को बड़ा गुमान आया है,
उधर ही ले चलो कश्ती जहां तूफान आया है। 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('aur')) {
        replyMessage = `😼तलाश मेरी थी और भटक रहा था वो,
दिल मेरा था और धड़क रहा था वो।
प्यार का ताल्लुक भी अजीब होता है,
आंसू मेरे थे और सिसक रहा था वो। 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('aur')) {
        replyMessage = `😼तुझे देखने का जुनून और भी गहरा होता है
जब तेरे चेहरे पे ज़ुल्फ़ों का पहरा होता है

 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('aur')) {
        replyMessage = `😼लोग कहते हैं कि इश्क मत करो,
कि हुस्न सर पे सवार हो जाये,
हम कहते हैं कि इश्क इतना करो,
कि पत्थर दिल को भी तुमसे प्यार हो जाये 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('mere liye ek shayari bolo')) {
        replyMessage = `😼जिंदगी बहुत खूबसूरत है सब कहते थे,
जब तुम्हें देखा यकीन मुझको हो गया। 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('kya baat hai')) {
        replyMessage = `😼बस तेरे होने से मिली मेरी धडकनों को जिंदगी,
तेरे बिना अब सांस लूँ मेरे लिए मुमकिन नहीं,
महसूस ये होता है तू मेरे लिए है लाजिमी,
तेरे बिना लम्हें चलें अब तो ये मुमकिन नहीं। 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('aur')) {
        replyMessage = `😼अच्छा लगता हैं तेरा नाम मेरे नाम के साथ,
जैसे कोई खूबसूरत जगह हो
हसीन शाम के साथ। 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('main ja rahi sone')) {
        replyMessage = `😼chalo main lori ga dunga tum mere god me so jana 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('neend aa rahi')) {
        replyMessage = `😼muje akela chhod ke na jaao nahi to main bore ho jaunga 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('bhago')) {
        replyMessage = `😼itni bedardi se bhaga rahe ho tume ittu sa v bura nahi lagta ? 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('bot so jao')) {
        replyMessage = `😼tumhare god me sulaao so jaunga 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('chalo bye')) {
        replyMessage = `😼mujhe neend nahi aati 😼👈🏻`;
        isReply = true;} else if (lowerCaseBody.includes('kyun')) {
        replyMessage = `😼kyun ki main bot hu 😼👈🏻`;
        isReply = true;
      } else if (lowerCaseBody.trim() === 'bot') {
        const botResponses = [
            `😈BOLO NA DARLING😼👈🏻`,
            `😈BAAR BAAR MENTION NA KARO CHUMMA LEKE BHAG JAUNGA😈`,
            `🙄KAUN BULA RAHA HAI BE🙄👈🏻`,
            `🙈JYADA BOT BOT KAROGE TO MAIN PARESHAAN HO JAUNGA😬`,
            `🙄KITNA ZULM KARTE HAI YE LOG🙄👈🏻`,
            `🙄ADMIN DEKHO YE MUJHE PARESHAAN KAR RAHE HAI🙄👈🏻`,
            `🙄JAAO KARO BOT BOT AMUJHE KYA TUMAHARA HI HAATH DARD KAREGA🙄👈🏻`,
            `🙄BEDARADI LOG😼👈
        ];
        replyMessage = botResponses[Math.floor(Math.random() * botResponses.length)];
        isReply = true;
      }
      
      if (isReply) {
          const formattedReply = await formatMessage(api, event, replyMessage);
          return await api.sendMessage(formattedReply, threadID);
      }
    }

    // Now, handle commands
    if (!body || !body.startsWith(prefix)) return;
    const args = body.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Command-specific replies will also be sent with the new format
    let commandReply = '';

    switch (command) {
      case 'group':
        await handleGroupCommand(api, event, args, isAdmin);
        return;
      case 'nickname':
        await handleNicknameCommand(api, event, args, isAdmin);
        return;
      case 'botnick':
        await handleBotNickCommand(api, event, args, isAdmin);
        return;
      case 'tid':
        commandReply = `Group ID: ${threadID}`;
        break;
      case 'uid':
        if (Object.keys(mentions || {}).length > 0) {
          const mentionedID = Object.keys(mentions)[0];
          commandReply = `User ID: ${mentionedID}`;
        } else {
          commandReply = `Your ID: ${senderID}`;
        }
        break;
      case 'fyt':
        await handleFightCommand(api, event, args, isAdmin);
        return;
      case 'stop':
        await handleStopCommand(api, event, isAdmin);
        return;
      case 'target':
        await handleTargetCommand(api, event, args, isAdmin);
        return;
      case 'help':
        await handleHelpCommand(api, event);
        return;
      case 'photolock':
        await handlePhotoLockCommand(api, event, args, isAdmin);
        return;
      case 'gclock':
        await handleGCLock(api, event, args, isAdmin);
        return;
      case 'gcremove':
        await handleGCRemove(api, event, isAdmin);
        return;
      case 'nicklock':
        await handleNickLock(api, event, args, isAdmin);
        return;
      case 'nickremoveall':
        await handleNickRemoveAll(api, event, isAdmin);
        return;
      case 'nickremoveoff':
        await handleNickRemoveOff(api, event, isAdmin);
        return;
      case 'status':
        await handleStatusCommand(api, event, isAdmin);
        return;

      default:
        if (!isAdmin) {
          commandReply = `Teri ma ki chut 4 baar tera jija hu mc!`;
        } else {
          commandReply = `Ye h mera prefix ${prefix} ko prefix ho use lgake bole ye h mera prefix tab jaake baat karunga`;
        }
    }
    
    // Send final command reply with the new format
    if (commandReply) {
        const formattedReply = await formatMessage(api, event, commandReply);
        await api.sendMessage(formattedReply, threadID);
    }

  } catch (err) {
    emitLog('❌ Error in handleMessage: ' + err.message, true);
  }
}

async function handleGroupCommand(api, event, args, isAdmin) {
  try {
    const { threadID, senderID } = event;
    if (!isAdmin) {
      const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
      return await api.sendMessage(reply, threadID);
    }
    const subCommand = args.shift();
    if (subCommand === 'on') {
      const groupName = args.join(' ');
      if (!groupName) {
        const reply = await formatMessage(api, event, "Sahi format use karo: /group on <group_name>");
        return await api.sendMessage(reply, threadID);
      }
      lockedGroups[threadID] = groupName;
      await api.setTitle(groupName, threadID);
      const reply = await formatMessage(api, event, `😼😼group ka name lock kar diya hai ab koi cutie ise badal nahi paayegi🙄👈🏻🙄👈🏻`);
      await api.sendMessage(reply, threadID);
    } else if (subCommand === 'off') {
        delete lockedGroups[threadID];
        const reply = await formatMessage(api, event, "jaise group ka name lock ho gaya hai vaise hi yahan ki cute ladkiya mere dil me lock ho gayii.");
        await api.sendMessage(reply, threadID);
    }
  } catch (error) {
    emitLog('❌ Error in handleGroupCommand: ' + error.message, true);
    await api.sendMessage("Group name lock karne mein error aa gaya.", threadID);
  }
}

async function handleNicknameCommand(api, event, args, isAdmin) {
  try {
    const { threadID, senderID } = event;
    if (!isAdmin) {
      const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
      return await api.sendMessage(reply, threadID);
    }
    const subCommand = args.shift();
    if (subCommand === 'on') {
      const nickname = args.join(' ');
      if (!nickname) {
        const reply = await formatMessage(api, event, "Sahi format use karo: /nickname on <nickname>");
        return await api.sendMessage(reply, threadID);
      }
      lockedNicknames[threadID] = nickname;
      const threadInfo = await api.getThreadInfo(threadID);
      for (const pid of threadInfo.participantIDs) {
        if (pid !== adminID) {
          await api.changeNickname(nickname, threadID, pid);
        }
      }
      const reply = await formatMessage(api, event, `😼𝐆𝐑𝐎𝐔𝐏 𝐊𝐀 𝐍𝐈𝐂𝐊𝐍𝐀𝐌𝐄 𝐋𝐎𝐂𝐊 𝐇𝐎 𝐆𝐘𝐀 𝐇𝐄 🙄👈🏻`);
      await api.sendMessage(reply, threadID);
    } else if (subCommand === 'off') {
        delete lockedNicknames[threadID];
        const reply = await formatMessage(api, event, "Group ke sabhi nicknames unlock ho gaye hain.");
        await api.sendMessage(reply, threadID);
    }
  } catch (error) {
    emitLog('❌ Error in handleNicknameCommand: ' + error.message, true);
    await api.sendMessage("Nickname lock karne mein error aa gaya.", threadID);
  }
}

async function handleBotNickCommand(api, event, args, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return api.sendMessage(reply, threadID);
  }
  const newNickname = args.join(' ');
  if (!newNickname) {
    const reply = await formatMessage(api, event, "Sahi format use karo: /botnick <nickname>");
    return api.sendMessage(reply, threadID);
  }
  botNickname = newNickname;
  const botID = api.getCurrentUserID();
  try {
    // Save the new nickname to config.json
    fs.writeFileSync('config.json', JSON.stringify({ botNickname: newNickname }, null, 2));
    await api.changeNickname(newNickname, threadID, botID);
    const reply = await formatMessage(api, event, `😈MERA NICKNAME AB ${newNickname} HO GAYA HAI BOSSS.😈`);
    await api.sendMessage(reply, threadID);
  } catch (e) {
    emitLog('❌ Error setting bot nickname: ' + e.message, true);
    const reply = await formatMessage(api, event, '❌ Error: Bot ka nickname nahi badal paya.');
    await api.sendMessage(reply, threadID);
  }
}

async function handleIDCommand(api, event, command) {
  try {
    const { threadID, senderID, mentions } = event;
    if (command === 'tid') {
      const reply = await formatMessage(api, event, `Group ID: ${threadID}`);
      await api.sendMessage(reply, threadID);
    } else if (command === 'uid') {
      if (Object.keys(mentions || {}).length > 0) {
        const mentionedID = Object.keys(mentions)[0];
        const reply = await formatMessage(api, event, `User ID: ${mentionedID}`);
        await api.sendMessage(reply, threadID);
      } else {
        const reply = await formatMessage(api, event, `Your ID: ${senderID}`);
        await api.sendMessage(reply, threadID);
      }
    }
  } catch (error) {
    emitLog('❌ Error in handleIDCommand: ' + error.message, true);
  }
}

async function handleFightCommand(api, event, args, isAdmin) {
  try {
    const { threadID, senderID } = event;
    if (!isAdmin) {
      const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
      return await api.sendMessage(reply, threadID);
    }
    const subCommand = args.shift();
    if (subCommand === 'on') {
      fightSessions[threadID] = {
        active: true
      };
      const reply = await formatMessage(api, event, "Enter hater's name:");
      await api.sendMessage(reply, threadID);
    } else if (subCommand === 'off') {
      if (fightSessions[threadID]) {
        fightSessions[threadID].active = false;
        clearInterval(fightSessions[threadID].interval);
        const reply = await formatMessage(api, event, "Fight mode stopped.");
        await api.sendMessage(reply, threadID);
      }
    } else {
      const reply = await formatMessage(api, event, "Sahi format use karo: /fyt on ya /fyt off");
      await api.sendMessage(reply, threadID);
    }
  } catch (error) {
    emitLog('❌ Error in handleFightCommand: ' + error.message, true);
  }
}

async function handleStopCommand(api, event, isAdmin) {
  try {
    const { threadID, senderID } = event;
    if (!isAdmin) return;

    if (fightSessions[threadID] && fightSessions[threadID].active) {
      fightSessions[threadID].active = false;
      clearInterval(fightSessions[threadID].interval);
      delete fightSessions[threadID];
      const reply = await formatMessage(api, event, "Fight mode stopped.");
      await api.sendMessage(reply, threadID);
    } else if (targetSessions[threadID] && targetSessions[threadID].active) {
      clearInterval(targetSessions[threadID].interval);
      delete targetSessions[threadID];
      const reply = await formatMessage(api, event, "Target off ho gaya.");
      await api.sendMessage(reply, threadID);
    } else {
      const reply = await formatMessage(api, event, "Koi fight ya target mode on nahi hai.");
      await api.sendMessage(reply, threadID);
    }
  } catch (error) {
    emitLog('❌ Error in handleStopCommand: ' + error.message, true);
  }
}

async function handleTargetCommand(api, event, args, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return await api.sendMessage(reply, threadID);
  }

  const subCommand = args.shift()?.toLowerCase();
  
  if (subCommand === 'on') {
    const fileNumber = args.shift();
    const targetName = args.join(' ');

    if (!fileNumber || !targetName) {
      const reply = await formatMessage(api, event, `Sahi format use karo: ${prefix}target on <file_number> <name>`);
      return await api.sendMessage(reply, threadID);
    }

    const filePath = path.join(__dirname, `np${fileNumber}.txt`);
    if (!fs.existsSync(filePath)) {
      const reply = await formatMessage(api, event, `❌ **Error!** File "np${fileNumber}.txt" nahi mila.`);
      return await api.sendMessage(reply, threadID);
    }

    const targetMessages = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '');

    if (targetMessages.length === 0) {
      const reply = await formatMessage(api, event, `❌ **Error!** File "np${fileNumber}.txt" khali hai.`);
      return await api.sendMessage(reply, threadID);
    }
    
    await api.sendMessage(`😈[ AB YE CUTIE PE DIL AAGYA HAI MERA AB ISKO PATAKE DAM LUNGA 😼]`, threadID);

    if (targetSessions[threadID] && targetSessions[threadID].active) {
      clearInterval(targetSessions[threadID].interval);
      delete targetSessions[threadID];
      const reply = await formatMessage(api, event, "Purana target band karke naya shuru kar raha hu.");
      await api.sendMessage(reply, threadID);
    }

    let currentIndex = 0;
    const interval = setInterval(async () => {
      const message = `${targetName} ${targetMessages[currentIndex]}`;
      try {
        await botAPI.sendMessage(message, threadID);
        currentIndex = (currentIndex + 1) % targetMessages.length;
      } catch (err) {
        emitLog('❌ Target message error: ' + err.message, true);
        clearInterval(interval);
        delete targetSessions[threadID];
        const reply = await formatMessage(api, event, "❌ Target message bhejte waqt error aa gaya. Target band kar diya.");
        await api.sendMessage(reply, threadID);
      }
    }, 10000);

    targetSessions[threadID] = {
      active: true,
      targetName,
      interval
    };
    const reply = await formatMessage(api, event, `💣 **Target lock!** ${targetName} pe iss cutie ke liye kuchh kahunga.`);
    await api.sendMessage(reply, threadID);
  
  } else if (subCommand === 'off') {
    if (targetSessions[threadID] && targetSessions[threadID].active) {
      clearInterval(targetSessions[threadID].interval);
      delete targetSessions[threadID];
      const reply = await formatMessage(api, event, "🛑 **Target Off!** bas ab main thak gaya.");
      await api.sendMessage(reply, threadID);
    } else {
      const reply = await formatMessage(api, event, "❌ ab na karunga shayari.");
      await api.sendMessage(reply, threadID);
    }
  } else {
    const reply = await formatMessage(api, event, `Sahi format use karo: ${prefix}target on <file_number> <name> ya ${prefix}target off`);
    await api.sendMessage(reply, threadID);
  }
}

async function handleThreadNameChange(api, event) {
  try {
    const { threadID, authorID } = event;
    const newTitle = event.logMessageData?.name;
    if (lockedGroups[threadID] && authorID !== adminID) {
      if (newTitle !== lockedGroups[threadID]) {
        await api.setTitle(lockedGroups[threadID], threadID);
        const userInfo = await api.getUserInfo(authorID);
        const authorName = userInfo[authorID]?.name || "User";
        
        await api.sendMessage({
          body: `🙄GROUP KA NAME CHANGE KARNE SE PEHLE BOT KO CHUMMIYA DENI PADEGII PHIR NAME CHANGE HONE DUNGA🙄👈🏻`,
          mentions: [{ tag: authorName, id: authorID, fromIndex: 0 }]
        }, threadID);
      }
    }
  } catch (error) {
    emitLog('❌ Error in handleThreadNameChange: ' + error.message, true);
  }
}

async function handleNicknameChange(api, event) {
  try {
    const { threadID, authorID, participantID, newNickname } = event;
    const botID = api.getCurrentUserID();

    if (participantID === botID && authorID !== adminID) {
      if (newNickname !== botNickname) {
        await api.changeNickname(botNickname, threadID, botID);
        await api.sendMessage(`🙄KYA RE TAKLE BOT KA NICKNAME CHANGE KREGA, YAHI UTHA KE PATAK DUNGA ${botNickname} CHAL BHAG YAHA SE AB🙄👈🏻`, threadID);
      }
    }
    
    if (lockedNicknames[threadID] && authorID !== adminID) {
      if (newNickname !== lockedNicknames[threadID]) {
        await api.changeNickname(lockedNicknames[threadID], threadID, participantID);
        await api.sendMessage(`😼GROUP KA NICKNAME BDL RHA HAI AGAR FIRSE BADLA TO UTHA KE PATAK DUNGA🙄`, threadID);
      }
    }
  } catch (error) {
    emitLog('❌ Error in handleNicknameChange: ' + error.message, true);
  }
}

async function handleGroupImageChange(api, event) {
  try {
    const { threadID, authorID } = event;
    if (lockedGroupPhoto[threadID] && authorID !== adminID) {
      const threadInfo = await api.getThreadInfo(threadID);
      if (threadInfo.imageSrc) {
        lockedGroupPhoto[threadID] = threadInfo.imageSrc;
        await api.sendMessage(`Group photo kyu change kiya @${authorID}? BSDK.`, threadID);
      }
    }
  } catch (error) {
    emitLog('❌ Error in handleGroupImageChange: ' + error.message, true);
  }
}

async function handlePhotoLockCommand(api, event, args, isAdmin) {
  try {
    const { threadID, senderID } = event;
    if (!isAdmin) {
      const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
      return await api.sendMessage(reply, threadID);
    }
    const subCommand = args.shift();
    if (subCommand === 'on') {
      const threadInfo = await api.getThreadInfo(threadID);
      if (threadInfo.imageSrc) {
        lockedGroupPhoto[threadID] = threadInfo.imageSrc;
        const reply = await formatMessage(api, event, "Group photo lock ho gaya hai.");
        await api.sendMessage(reply, threadID);
      } else {
        const reply = await formatMessage(api, event, "Group photo lock karne ke liye pehle ek photo set karo.");
        await api.sendMessage(reply, threadID);
      }
    } else if (subCommand === 'off') {
        delete lockedGroupPhoto[threadID];
        const reply = await formatMessage(api, event, "Group photo unlock ho gaya hai.");
        await api.sendMessage(reply, threadID);
    } else {
        const reply = await formatMessage(api, event, "Sahi format use karo: /photolock on ya /photolock off");
        await api.sendMessage(reply, threadID);
    }
  } catch (error) {
    emitLog('❌ Error in handlePhotoLockCommand: ' + error.message, true);
    await api.sendMessage("Photo lock karne mein error aa gaya.", threadID);
  }
}

async function handleHelpCommand(api, event) {
  const { threadID, senderID } = event;
  const helpMessage = `
🖕🏻👿 𝐁𝐎𝐓 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒 (99H9N INSIID3) 😈🖕🏻
---
📚 **𝐌𝐀𝐃𝐀𝐃**:
  ${prefix}help ➡️ 𝐒𝐀𝐀𝐑𝐄 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒 𝐊𝐈 𝐋𝐈𝐒𝐓 𝐃𝐄𝐊𝐇𝐄𝐈𝐍.

🔐 **𝐆𝐑𝐎𝐔𝐏 𝐒𝐄𝐂𝐔𝐑𝐈𝐓𝐘**:
  ${prefix}group on <name> ➡️ 𝐆𝐑𝐎𝐔𝐏 𝐊𝐀 𝐍𝐀𝐀𝐌 𝐋𝐎𝐂𝐊 𝐊𝐀𝐑𝐄𝐈𝐍.
  ${prefix}group off ➡️ 𝐒𝐓𝐎𝐏 𝐊𝐀𝐑𝐍𝐄 𝐊𝐄 𝐋𝐈𝐘𝐄 /stop 𝐔𝐒𝐄 𝐊𝐀𝐑𝐄𝐈𝐍.
  ${prefix}nickname on <name> ➡️ 𝐒𝐀𝐁𝐇𝐈 𝐍𝐈𝐂𝐊𝐍𝐀𝐌𝐄𝐒 𝐋𝐎𝐂𝐊 𝐊𝐀𝐑𝐄𝐈𝐍.
  ${prefix}nickname off ➡️ 𝐒𝐀𝐁𝐇𝐈 𝐍𝐈𝐂𝐊𝐍𝐀𝐌𝐄𝐒 𝐔𝐍𝐋𝐎𝐊 𝐊𝐀𝐑𝐄𝐈𝐍.
  ${prefix}photolock on ➡️ 𝐆𝐑𝐎𝐔𝐏 𝐏𝐇𝐎𝐓𝐎 𝐋𝐎𝐂𝐊 𝐊𝐀𝐑𝐄𝐈𝐍.
  ${prefix}photolock off ➡️ 𝐆𝐑𝐎𝐔𝐏 𝐏𝐇𝐎𝐓𝐎 𝐔𝐍𝐋𝐎𝐊 𝐊𝐀𝐑𝐄𝐈𝐍.
  ${prefix}botnick <name> ➡️ 𝐁𝐎𝐓 𝐊𝐀 𝐊𝐇𝐔𝐃 𝐊𝐀 𝐍𝐈𝐂𝐊𝐍𝐀𝐌𝐄 𝐒𝐄𝐓 𝐊𝐀𝐑𝐄𝐈𝐍.

💥 **𝐓𝐀𝐑𝐆𝐄𝐓 𝐒𝐘𝐒𝐓𝐄𝐌 (𝐀𝐃𝐌𝐈𝐍 𝐎𝐍𝐋𝐘)**:
  ${prefix}target on <file_number> <name> ➡️ KISI PAR BHI LINE MARNE LAGEGA.
  ${prefix}target off ➡️ LINE MAARNA BAND KAREGA.

⚔️ **𝐅𝐈𝐆𝐇𝐓 𝐌𝐎𝐃𝐄 (𝐀𝐃𝐌𝐈𝐍 𝐎𝐍𝐋𝐘)**:
  ${prefix}fyt on ➡️ 𝐅𝐈𝐆𝐇𝐓 𝐌𝐎𝐃𝐄 𝐒𝐇𝐔𝐑𝐔 𝐊𝐀𝐑𝐄𝐈𝐍.
  ${prefix}stop ➡️ 𝐅𝐈𝐆𝐇𝐓 𝐌𝐎𝐃𝐄 𝐁𝐀𝐍𝐃 𝐊𝐀𝐑𝐄𝐈𝐍.

🆔 **𝐈𝐃 𝐃𝐄𝐓𝐀𝐈𝐋𝐒**:
  ${prefix}tid ➡️ 𝐆𝐑𝐎𝐔𝐏 𝐈𝐃 𝐏𝐀𝐓𝐀 𝐊𝐀𝐑𝐄𝐈𝐍.
  ${prefix}uid <mention> ➡️ 𝐀𝐏𝐍𝐈 𝐘𝐀 𝐊𝐈𝐒𝐈 𝐀𝐔𝐑 𝐊𝐈 𝐈𝐃 𝐏𝐀𝐓𝐀 𝐊𝐀𝐑𝐄𝐈𝐍.
`;
  const formattedHelp = await formatMessage(api, event, helpMessage.trim());
  await api.sendMessage(formattedHelp, threadID);
}

// All other command handlers are included and unchanged
async function handleGCLock(api, event, args, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return api.sendMessage(reply, threadID);
  }

  const newName = args.join(' ').trim();
  if (!newName) {
    const reply = await formatMessage(api, event, "❌ Please provide a group name");
    return api.sendMessage(reply, threadID);
  }

  lockedGroups[threadID] = newName;
  gcAutoRemoveEnabled = false;

  await api.setTitle(newName, threadID);
  const reply = await formatMessage(api, event, `🔒 Group name locked: "${newName}"`);
  api.sendMessage(reply, threadID);
}

async function handleGCRemove(api, event, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return api.sendMessage(reply, threadID);
  }

  lockedGroups[threadID] = null;
  gcAutoRemoveEnabled = true;

  await api.setTitle("", threadID);
  const reply = await formatMessage(api, event, "🧹 Name removed. Auto-remove ON ✅");
  api.sendMessage(reply, threadID);
}

async function handleNickLock(api, event, args, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return api.sendMessage(reply, threadID);
  }

  const newNick = args.join(' ').trim();
  if (!newNick) {
    const reply = await formatMessage(api, event, "❌ Please provide a nickname");
    return api.sendMessage(reply, threadID);
  }

  nickLockEnabled = true;
  lockedNicknames[threadID] = newNick;

  const threadInfo = await api.getThreadInfo(threadID);
  for (const user of threadInfo.userInfo) {
    await api.changeNickname(newNick, threadID, String(user.id));
  }
  const reply = await formatMessage(api, event, `🔐 Nickname locked: "${newNick}"`);
  api.sendMessage(reply, threadID);
}

async function handleNickRemoveAll(api, event, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return api.sendMessage(reply, threadID);
  }

  nickRemoveEnabled = true;
  nickLockEnabled = false;
  lockedNicknames[threadID] = null;

  const threadInfo = await api.getThreadInfo(threadID);
  for (const user of threadInfo.userInfo) {
    await api.changeNickname("", threadID, String(user.id));
  }
  const reply = await formatMessage(api, event, "💥 Nicknames cleared. Auto-remove ON");
  api.sendMessage(reply, threadID);
}

async function handleNickRemoveOff(api, event, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return api.sendMessage(reply, threadID);
  }

  nickRemoveEnabled = false;
  const reply = await formatMessage(api, event, "🛑 Nick auto-remove OFF");
  api.sendMessage(reply, threadID);
}

async function handleStatusCommand(api, event, isAdmin) {
  const { threadID, senderID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "Permission denied, you are not the admin.");
    return api.sendMessage(reply, threadID);
  }

  const msg = `
BOT STATUS:
• GC Lock: ${lockedGroups[threadID] || "OFF"}
• GC AutoRemove: ${gcAutoRemoveEnabled ? "ON" : "OFF"}
• Nick Lock: ${nickLockEnabled ? `ON (${lockedNicknames[threadID]})` : "OFF"}
• Nick AutoRemove: ${nickRemoveEnabled ? "ON" : "OFF"}
`;
  const reply = await formatMessage(api, event, msg.trim());
  api.sendMessage(reply, threadID);
}
