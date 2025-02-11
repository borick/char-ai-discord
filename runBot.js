// index.js

// Required modules and initial setup
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    EndBehaviorType,
    StreamType
} = require('@discordjs/voice');
const { createClient } = require("@deepgram/sdk");
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const fs = require('fs');
const axios = require('axios');
const ffmpeg = require('ffmpeg-static');
const prism = require('prism-media');
const path = require('path');

// When true, sends a message in the text channel with the playback URL.
const play_in_channel = false;

dotenv.config();

let ffmpegProcess = null;
let caiClient = null;

// Global audio queue and flag to prevent simultaneous playbacks.
const audioQueue = [];
let isPlayingAudio = false;

// Global variable to store the voice channel ID being listened to (for joinall mode)
let listeningChannelId = null;

// Map to keep track of active listeners per user
const activeListeners = new Map();

// Map to store conversation contexts per user
const userConversations = new Map();

(async function() {
    caiClient = new (await import("cainode")).CAINode();
    console.log("Logging in...");
    await caiClient.login(process.env.CHARACTER_AI_TOKEN);
    console.log(`Connecting to character [${process.env.CHARACTER_ID}]...`);
    await caiClient.character.connect(process.env.CHARACTER_ID);
})();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.User
    ]
});

const deepgram = createClient(process.env.DEEPGRAM_KEY);
let currentConnection;

// Import the state manager
const { saveState, loadState, clearState } = require('./stateManager');

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Load state
    const state = loadState();

    if (state) {
        const guild = client.guilds.cache.get(state.guildId);
        const voiceChannel = guild.channels.cache.get(state.channelId);

        if (voiceChannel) {
            currentConnection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            console.log(`Rejoined voice channel: ${voiceChannel.name}`);

            if (state.command === 'join') {
                // Re-enact the join command for the specific user
                const member = guild.members.cache.get(state.userId);
                if (member) {
                    const message = {}; // Mock message object
                    message.member = member;
                    await joinVoiceChannelHandler(message, true);
                }
            } else if (state.command === 'joinall') {
                // Re-enact the joinall command
                const member = guild.members.cache.get(state.userId);
                if (member) {
                    const message = {}; // Mock message object
                    message.member = member;
                    await joinAllVoiceChannelHandler(message, true);
                }
            }
        } else {
            console.log('Voice channel not found. Clearing saved state.');
            clearState();
        }
    }
});

client.on('messageCreate', async message => {
    if (!message.content.startsWith('!') || message.author.bot) return;

    const args = message.content.slice(1).split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'join') {
        joinVoiceChannelHandler(message);
    }

    if (command === 'joinall') {
        joinAllVoiceChannelHandler(message);
    }

    if (command === 'leave') {
        leaveVoiceChannelHandler(message);
    }
});

/**
 * Handler for the original join command that listens to just the command issuer.
 */
async function joinVoiceChannelHandler(message, isRejoin = false) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
        if (!isRejoin) message.reply('Join a voice channel first!');
        return;
    }

    currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    // Clear the global channel tracker (this is single-user mode)
    listeningChannelId = null;

    // Save state
    saveState({
        command: 'join',
        guildId: voiceChannel.guild.id,
        channelId: voiceChannel.id,
        userId: message.member.id
    });

    const receiver = currentConnection.receiver;

    // Clean up existing listener if any
    if (activeListeners.has(message.member.id)) {
        const { decoderStream } = activeListeners.get(message.member.id);
        decoderStream.removeAllListeners();
        decoderStream.destroy();
        activeListeners.delete(message.member.id);
    }

    // Subscribe only to the command issuer
    listenToUser(message.member, receiver, { message });

    if (!isRejoin) message.reply(`Listening to ${message.author.username}...`);
}

/**
 * New handler for the joinall command.
 * This joins the caller's voice channel and subscribes to every non-bot member's audio.
 */
async function joinAllVoiceChannelHandler(message, isRejoin = false) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
        if (!isRejoin) message.reply('Join a voice channel first!');
        return;
    }

    // Store the channel ID globally for joinall mode
    listeningChannelId = voiceChannel.id;

    currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    // Save state
    saveState({
        command: 'joinall',
        guildId: voiceChannel.guild.id,
        channelId: voiceChannel.id,
        userId: message.member.id
    });

    if (!isRejoin) message.reply(`Listening to everyone in ${voiceChannel.name}...`);

    const receiver = currentConnection.receiver;
    // Subscribe to all current non-bot members in the channel
    voiceChannel.members.forEach(member => {
        if (member.user.bot) return;
        listenToUser(member, receiver, { voiceChannel });
    });
}

/**
 * Helper function to listen to a specific user in the voice channel.
 * When their audio stream ends (after a period of silence), it processes the audio
 * and then re-subscribes so that the bot keeps listening for that user.
 */
function listenToUser(member, receiver, context) {
    // Check if there's already an active listener
    if (activeListeners.has(member.id)) {
        console.log(`Already listening to ${member.user.username}, skipping.`);
        return;
    }

    const subscription = receiver.subscribe(member.id, {
        end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 2000
        }
    });

    const opusDecoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 1,
        frameSize: 960
    });

    let audioChunks = [];
    const decoderStream = subscription.pipe(opusDecoder);

    decoderStream.on('data', (chunk) => {
        audioChunks.push(chunk);
    });

    decoderStream.on('end', async () => {
        if (audioChunks.length === 0) {
            // Re-listen if no audio was captured
            resubscribeIfNecessary(member, receiver, context);
            return;
        }

        try {
            const wavBuffer = await convertToWav(Buffer.concat(audioChunks));
            // Optionally save the recording
            // const tempFilename = `recording_${member.id}.wav`;
            // await fs.promises.writeFile(tempFilename, wavBuffer);

            const transcript = await transcribeAudio(wavBuffer);
            console.log(`Transcript from ${member.user.username}:`, transcript);

            if (!transcript) {
                console.log('Empty response retrieved, returning');
                resubscribeIfNecessary(member, receiver, context);
                return;
            }

            // Pass the member object to maintain conversation context
            await getAIResponse(transcript, currentConnection, { reply: () => {} }, false, member);
        } catch (error) {
            console.error(`Error processing audio from ${member.user.username}:`, error);
        }

        // Re-subscribe for this member if they are still in the channel
        resubscribeIfNecessary(member, receiver, context);
    });

    // Add error handling for the decoderStream
    decoderStream.on('error', (error) => {
        console.error(`Decoder stream error for ${member.user.username}:`, error);
        // Clean up the stream
        decoderStream.removeAllListeners();
        decoderStream.destroy();
        activeListeners.delete(member.id);
    });

    // Store the decoderStream in the Map
    activeListeners.set(member.id, { decoderStream });
}

/**
 * Helper function to re-subscribe to a user if necessary.
 */
function resubscribeIfNecessary(member, receiver, context) {
    if (member.voice.channel) {
        if (listeningChannelId && member.voice.channel.id === listeningChannelId) {
            if (!activeListeners.has(member.id)) {
                listenToUser(member, receiver, context);
            }
        } else if (context && context.voiceChannel && member.voice.channel.id === context.voiceChannel.id) {
            if (!activeListeners.has(member.id)) {
                listenToUser(member, receiver, context);
            }
        }
    } else {
        // Remove the listener and conversation if the user is no longer in the channel
        if (activeListeners.has(member.id)) {
            const { decoderStream } = activeListeners.get(member.id);
            decoderStream.removeAllListeners();
            decoderStream.destroy();
            activeListeners.delete(member.id);
        }
        if (userConversations.has(member.id)) {
            userConversations.delete(member.id);
        }
    }
}

/**
 * Listen for new members joining or leaving the voice channel in joinall mode.
 * This ensures that users who join after the command is issued are also subscribed.
 */
client.on('voiceStateUpdate', (oldState, newState) => {
    const member = newState.member;
    const receiver = currentConnection?.receiver;

    // Ensure that the voiceStateUpdate is for the same guild
    if (oldState.guild.id !== newState.guild.id) return;

    // User left the voice channel we're listening to
    if (oldState.channelId === listeningChannelId && newState.channelId !== listeningChannelId) {
        if (!member.user.bot && activeListeners.has(member.id)) {
            const { decoderStream } = activeListeners.get(member.id);
            decoderStream.removeAllListeners();
            decoderStream.destroy();
            activeListeners.delete(member.id);
            userConversations.delete(member.id); // Remove conversation context
            console.log(`Stopped listening to ${member.user.username} as they left the channel.`);
        }
    }

    // User joined the voice channel we're listening to
    if ((oldState.channelId !== listeningChannelId) && (newState.channelId === listeningChannelId)) {
        if (!member.user.bot && receiver) {
            console.log(`New member joined: ${member.user.username}`);
            listenToUser(member, receiver, { voiceChannel: member.voice.channel });
        }
    }
});

/**
 * Convert PCM audio buffer to WAV using FFmpeg.
 */
async function convertToWav(pcmBuffer) {
    return new Promise((resolve, reject) => {
        ffmpegProcess = spawn(ffmpeg, [
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '1',
            '-i', 'pipe:0',
            '-ar', '48000', // Output sample rate
            '-f', 's16le',
            '-f', 'wav',
            'pipe:1'
        ]);

        const buffers = [];
        ffmpegProcess.stdout.on('data', (data) => buffers.push(data));
        ffmpegProcess.on('close', (code) => {
            if (code !== 0) return reject(new Error(`FFmpeg exited with code ${code}`));
            resolve(Buffer.concat(buffers));
        });

        ffmpegProcess.stdin.write(pcmBuffer);
        ffmpegProcess.stdin.end();
    });
}

/**
 * Transcribe the given audio buffer using Deepgram.
 */
async function transcribeAudio(buffer) {
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
        buffer,
        {
            model: 'nova-2',
            smart_format: true,
            utterances: true,
            mimetype: 'audio/wav'
        }
    );
    if (error) {
        console.error('Error transcribing audio:', error);
        throw error;
    }
    return result?.results?.channels[0]?.alternatives[0]?.transcript || '';
}

/**
 * Get the AI response for a given prompt.
 * The optional parameter autoRestart (defaulting to true) determines whether we
 * automatically re-subscribe for audio after TTS playback finishes.
 */
async function getAIResponse(prompt, connection, message, autoRestart = true, member) {
    try {
        let response = null;
        let chatId = userConversations.get(member.id);

        if (!chatId) {
            // Start a new chat and store the chat ID
            // get list of group chats
            const chats = await caiClient.group_chat.list();
            console.log(chats);
            const chat = chats[0];
            chatId = chat ? chat.chatId : null;
            if (chatId) {
                userConversations.set(member.id, chatId);
            } else {
                console.error(`Failed to start new chat for ${member.user.username}`);
                return;
            }
        }

        try {
            response = await caiClient.character.send_message(prompt, false, "", {
                char_id: process.env.CHARACTER_ID,
                chat_id: chatId,
                timeout_ms: 10000,
            });
            console.log(`Response for ${member.user.username}:`, JSON.stringify(response, null, 2));
        } catch (error) {
            console.log(`Error sending message for ${member.user.username}:`, error);
            if (!response) {
                await caiClient.character.disconnect(process.env.CHARACTER_ID);
                console.log("Disconnected...trying again.");
            }
        }

        const ttsReply = await caiClient.character.replay_tts(
            response["turn"]["turn_key"]["turn_id"],
            response["turn"]["primary_candidate_id"],
            process.env.VOICE_ID,
        );

        const replayUrl = ttsReply["replayUrl"];
        // Instead of downloading the entire file to disk, we stream it.
        console.log(`Streaming file for ${member.user.username} from:`, replayUrl);
        const ttsStreamResponse = await axios.get(replayUrl, { responseType: 'stream' });

        console.log(`Queueing playback for ${member.user.username}...`);
        // Queue an item with the audio stream
        audioQueue.push({ connection, stream: ttsStreamResponse.data, message, autoRestart });
        processAudioQueue();

        if (play_in_channel && message && typeof message.reply === 'function') {
            message.reply(`Now playing: ${replayUrl}`);
        }
        console.log(`TTS Reply for ${member.user.username}:`, JSON.stringify(ttsReply, null, 2));

        return response;
    } catch (error) {
        console.error(`Error getting AI response for ${member.user.username}:`, error);
        throw error;
    }
}

/**
 * Processes the audio queue. If something is already playing or the queue is empty,
 * it does nothing. Otherwise, it dequeues the next audio, plays it, and once finished,
 * cleans up and recursively processes the next item.
 */
function processAudioQueue() {
    if (isPlayingAudio || audioQueue.length === 0) return;
    isPlayingAudio = true;

    // Each queue item can now have either a 'stream' or a 'tempFilePath'
    const { connection, stream, tempFilePath, message, autoRestart } = audioQueue.shift();

    const player = createAudioPlayer();
    let resource;
    if (stream) {
        // When using streaming audio, explicitly set the inputType
        resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    } else {
        // Fallback to file-based resource (if needed)
        resource = createAudioResource(fs.createReadStream(tempFilePath));
    }
    connection.subscribe(player);
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
        isPlayingAudio = false;
        if (tempFilePath) {
            // Only delete if a temporary file was used
            fs.unlink(tempFilePath, (err) => {
                if (err) console.error('Failed to delete temp file:', err);
            });
        }
        // In single-user mode, restart listening after playback finishes.
        if (autoRestart && message && message.member) {
            joinVoiceChannelHandler(message);
        }
        processAudioQueue();
    });

    player.on('error', (error) => {
        console.error("Error in audio player:", error);
        if (message && message.reply) {
            message.reply("⚠️ An error occurred while playing the audio.");
        }
        isPlayingAudio = false;
        processAudioQueue();
    });
}

/**
 * Handler to leave the voice channel.
 */
function leaveVoiceChannelHandler(message) {
    if (currentConnection) {
        currentConnection.destroy();
        currentConnection = null;
        listeningChannelId = null;

        // Clean up all active listeners
        activeListeners.forEach(({ decoderStream }, memberId) => {
            decoderStream.removeAllListeners();
            decoderStream.destroy();
        });
        activeListeners.clear();
        userConversations.clear(); // Clear all conversation contexts

        // Clear state
        clearState();

        message.reply('Left the voice channel!');
    }
}

client.login(process.env.DISCORD_BOT_TOKEN);
