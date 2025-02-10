const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, EndBehaviorType } = require('@discordjs/voice');
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

// put message of url in channel
const play_in_channel = false;

let ffmpegProcess = null;
let caiClient = null;

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

            // Don't do anything if transcript is empty
            console.log('Transcript:', transcript);
            console.log('Empty response retrieved, returning')
            if (!transcript) return;
            
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

    currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    message.reply(`Listening to everyone in ${voiceChannel.name}...`);

    const receiver = currentConnection.receiver;
    // Iterate over all members in the channel (skip bots)
    voiceChannel.members.forEach(member => {
        if (member.user.bot) return;
        listenToUser(member, receiver, message);
    });
}

/**
 * Helper function to listen to a specific user in the voice channel.
 * When their audio stream ends (after a period of silence), it processes the audio
 * and then re-subscribes so that the bot keeps listening for that user.
 */
function listenToUser(member, receiver, message) {
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
            return listenToUser(member, receiver, message);
        }

        try {
            const wavBuffer = await convertToWav(Buffer.concat(audioChunks));
            // Save a temporary file that includes the member's ID in the name (optional)
            const tempFilename = `recording_${member.id}.wav`;
            await fs.promises.writeFile(tempFilename, wavBuffer);
            const transcript = await transcribeAudio(wavBuffer);
            console.log(`Transcript from ${member.user.username}:`, transcript);
            // Don't do anything if transcript is empty
            console.log('Empty response retrieved, returning')
            if (!transcript) {
                if (member.voice.channel && member.voice.channel.id === message.member.voice.channel.id) {
                    listenToUser(member, receiver, message);
                }
                return;
            }

            // Pass autoRestart=false for joinall mode so that we don’t trigger a global re-subscription.
            const response = await getAIResponse(transcript, currentConnection, message, false);
            console.log('AI Response:', response);
        } catch (error) {
            console.error(`Error processing audio from ${member.user.username}:`, error);
        }

        // Re-subscribe for this member if they are still in the same voice channel.
        if (member.voice.channel && member.voice.channel.id === message.member.voice.channel.id) {
            listenToUser(member, receiver, message);
        }
    });
}

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
 * Download a file from the given URL and save it at tempFilePath.
 */
async function downloadFile(url, tempFilePath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(tempFilePath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to download file. Status code: ${response.statusCode}`));
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(tempFilePath, () => reject(err));
        });
    });
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
            console.log(caiClient.character);

            const gc = await caiClient.group_chat.list();
            for (const group of gc["rooms"]) {
                console.log("disconnecting from group: " + group['id']);
                try {
                    await caiClient.group_chat.disconnect(group['id']);
                } catch (error) {
                    console.log("Error disconnecting from group: " + group['id']);
                }
            }
            try { 
                await caiClient.character.disconnect(process.env.CHARACTER_ID);
            } catch (error) {
                console.log("Error disconnecting from character: " + process.env.CHARACTER_ID);
            }
            
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
        const tempFilePath = path.join(__dirname, 'temp_audio_file.mp3'); // Temporary file location

        console.log('Downloading file...');
        await downloadFile(replayUrl, tempFilePath);

        console.log('Starting playback...');

        const player = createAudioPlayer();
        const resource = createAudioResource(tempFilePath);
        player.play(resource);
        connection.subscribe(player);

        player.on("error", (error) => {
            console.error("Error in audio player:", error);
            message.reply("⚠️ An error occurred while playing the audio.");
        });

        // Only auto-restart in the single-user (join) case.
        if (autoRestart) {
            player.on(AudioPlayerStatus.Idle, () => {
                console.log('Playback finished, restarting listener...');
                joinVoiceChannelHandler(message);  // Restart listening after TTS plays
            });
        }

        ffmpegProcess.on('close', () => {
            fs.unlink(tempFilePath, (err) => {
                if (err) console.error('Failed to delete temp file:', err);
            });
        });

        if (play_in_channel) {
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
        message.reply('Left the voice channel!');
    }
}

client.login(process.env.DISCORD_BOT_TOKEN);
