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
const { PassThrough } = require('stream');
const axios = require('axios');
const ffmpeg = require('ffmpeg-static');
const prism = require('prism-media');
const playdl = require('play-dl');
const https = require('https');
const path = require('path');

// When true, sends a message in the text channel with the playback URL.
const play_in_channel = false;

let ffmpegProcess = null;
let caiClient = null;

// Global audio queue and flag to prevent simultaneous playbacks.
const audioQueue = [];
let isPlayingAudio = false;

// Global variable to store the voice channel ID being listened to (for joinall mode)
let listeningChannelId = null;

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
        if (autoRestart) {
            joinVoiceChannelHandler(message);
        }
        processAudioQueue();
    });

    player.on('error', (error) => {
        console.error("Error in audio player:", error);
        message.reply("⚠️ An error occurred while playing the audio.");
        isPlayingAudio = false;
        processAudioQueue();
    });
}

(async function() {
    caiClient = new (await import("cainode")).CAINode();
    await caiClient.login(process.env.CHARACTER_AI_TOKEN);
})();

dotenv.config();

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

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
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
async function joinVoiceChannelHandler(message) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('Join a voice channel first!');

    currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    // Clear the global channel tracker (this is single-user mode)
    listeningChannelId = null;

    const receiver = currentConnection.receiver;
    // Subscribe only to the command issuer
    const recorder = receiver.subscribe(message.member.id, {
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
    const decoderStream = recorder.pipe(opusDecoder);

    decoderStream.on('data', (chunk) => {
        audioChunks.push(chunk);
    });

    decoderStream.on('end', async () => {
        if (audioChunks.length === 0) return;

        try {
            const wavBuffer = await convertToWav(Buffer.concat(audioChunks));
            await fs.promises.writeFile('recording.wav', wavBuffer);
            const transcript = await transcribeAudio(wavBuffer);

            console.log('Transcript:', transcript);
            if (!transcript) {
                console.log('Empty response retrieved, returning');
                return;
            }
            
            // Pass autoRestart=true for single-user mode so that we restart the listener after TTS playback.
            const response = await getAIResponse(transcript, currentConnection, message, true);
            console.log('AI Response:', response);
        } catch (error) {
            console.error('Error processing audio:', error);
        }
    });

    message.reply(`Listening to ${message.author.username}...`);
}

/**
 * New handler for the joinall command.
 * This joins the caller's voice channel and subscribes to every non-bot member's audio.
 */
async function joinAllVoiceChannelHandler(message) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('Join a voice channel first!');

    // Store the channel ID globally for joinall mode
    listeningChannelId = voiceChannel.id;

    currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    message.reply(`Listening to everyone in ${voiceChannel.name}...`);

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
            return listenToUser(member, receiver, context);
        }

        try {
            const wavBuffer = await convertToWav(Buffer.concat(audioChunks));
            // Save a temporary file that includes the member's ID in the name (optional)
            const tempFilename = `recording_${member.id}.wav`;
            await fs.promises.writeFile(tempFilename, wavBuffer);
            const transcript = await transcribeAudio(wavBuffer);
            console.log(`Transcript from ${member.user.username}:`, transcript);
            if (!transcript) {
                console.log('Empty response retrieved, returning');
                // Re-subscribe if still in the same channel
                if (member.voice.channel && ((listeningChannelId && member.voice.channel.id === listeningChannelId) ||
                    (context && context.voiceChannel && member.voice.channel.id === context.voiceChannel.id))) {
                    listenToUser(member, receiver, context);
                }
                return;
            }

            // Pass autoRestart=false for joinall mode so that we don’t trigger a global re-subscription.
            const response = await getAIResponse(transcript, currentConnection, { reply: () => {} }, false);
            console.log('AI Response:', response);
        } catch (error) {
            console.error(`Error processing audio from ${member.user.username}:`, error);
        }

        // Re-subscribe for this member if they are still in the channel
        if (member.voice.channel) {
            if (listeningChannelId) {
                if (member.voice.channel.id === listeningChannelId) {
                    listenToUser(member, receiver, context);
                }
            } else if (context && context.voiceChannel && member.voice.channel.id === context.voiceChannel.id) {
                listenToUser(member, receiver, context);
            }
        }
    });
}

/**
 * Listen for new members joining the voice channel in joinall mode.
 * This ensures that users who join after the command is issued are also subscribed.
 */
client.on('voiceStateUpdate', (oldState, newState) => {
    // If a new member joins a voice channel and is not a bot...
    if (newState.channelId && !newState.member.user.bot) {
        // ...and if we're in joinall mode and the new member joined the channel we're listening to...
        if (currentConnection && listeningChannelId && newState.channelId === listeningChannelId) {
            console.log(`New member joined: ${newState.member.user.username}`);
            const receiver = currentConnection.receiver;
            listenToUser(newState.member, receiver, { voiceChannel: newState.member.voice.channel });
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
async function getAIResponse(prompt, connection, message, autoRestart = true) {
    try {
        let response = null;
        try {
            await PromisescaiClient.group_chat.connect(process.env.CHARACTER_ID);
            await caiClient.character.connect(process.env.CHARACTER_ID);
            response = await caiClient.character.send_message(prompt, false, "", {
                char_id: process.env.CHARACTER_ID,
                timeout_ms: 10000,
            });
            console.log(JSON.stringify(response, null, 2));
        } catch (error) {
            console.log(error);
            if (!response) {
                await caiClient.character.disconnect(process.env.CHARACTER_ID);
                console.log("Disconnected...try again.");
            }
        }

        const ttsReply = await caiClient.character.replay_tts(
            response["turn"]["turn_key"]["turn_id"],
            response["turn"]["primary_candidate_id"],
            process.env.VOICE_ID,
        );

        const replayUrl = ttsReply["replayUrl"];
        // Instead of downloading the entire file to disk, we stream it.
        console.log('Streaming file from:', replayUrl);
        const ttsStreamResponse = await axios.get(replayUrl, { responseType: 'stream' });
        
        console.log('Queueing playback...');
        // Queue an item with the audio stream
        audioQueue.push({ connection, stream: ttsStreamResponse.data, message, autoRestart });
        processAudioQueue();

        if (play_in_channel && message && typeof message.reply === 'function') {
            message.reply(`Now playing: ${replayUrl}`);
        }
        console.log(JSON.stringify(ttsReply, null, 2));

        return response;
    } catch (error) {
        console.error('Error getting AI response:', error);
        throw error;
    }
}

/**
 * Handler to leave the voice channel.
 */
function leaveVoiceChannelHandler(message) {
    if (currentConnection) {
        currentConnection.destroy();
        currentConnection = null;
        listeningChannelId = null;
        message.reply('Left the voice channel!');
    }
}

client.login(process.env.DISCORD_BOT_TOKEN);
