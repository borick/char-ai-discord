const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnectionStatus, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { createClient } = require("@deepgram/sdk");
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const fs = require('fs');
const { EndBehaviorType } = require("@discordjs/voice");
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

    if (command === 'leave') {
        leaveVoiceChannelHandler(message);
    }
});

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
            console.log('transcript:', transcript);
            const response = await getAIResponse(transcript, currentConnection, message);
            console.log('AI Response:', response);
        } catch (error) {
            console.error('Error processing audio:', error);
            // message.channel.send("Error processing request");
            console.log()
        }
    });

    message.reply(`Listening to ${message.author.username}...`);
}

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
    // console.log('Result: ', JSON.stringify(result, null, 2));
    return result?.results?.channels[0]?.alternatives[0]?.transcript || '';
}

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

async function getAIResponse(prompt, connection, message) {
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
            // This is OK
            console.log(error);
            if (!response) {
                // Disconnect from the chat
                await caiClient.character.disconnect(process.env.CHARACTER_ID);
                console.log("Disconnected...try again.");
            }
        }

        const ttsReply = await caiClient.character.replay_tts(
            response["turn"]["turn_key"]["turn_id"],
            response["turn"]["primary_candidate_id"],
            process.env.VOICE_ID,
        )

        const replayUrl = ttsReply["replayUrl"]
        
        const tempFilePath = path.join(__dirname, 'temp_audio_file.mp3'); // Temporary file location

        console.log('Downloading file...');
        await downloadFile(replayUrl, tempFilePath);

        console.log('Starting playback...');

        const player = createAudioPlayer();
        console.log('player created...');

        // Create audio resource from ffmpeg stdout
        console.log('Temp file: ', tempFilePath);

        const resource = createAudioResource(tempFilePath);
        console.log('Resource created.');

        player.play(resource);
        console.log('Playing resource');

        connection.subscribe(player);
        console.log('Player subscribed to connection.');

        player.on("error", (error) => {
            console.error("Error in audio player:", error);
            message.reply("⚠️ An error occurred while playing the audio.");
        });

        player.on(AudioPlayerStatus.Idle, () => {
            console.log('Playback finished, restarting listener...');
            joinVoiceChannelHandler(message);  // Restart listening after TTS plays
        });

        ffmpegProcess.on('close', () => {
            fs.unlink(tempFilePath, (err) => {
                if (err) console.error('Failed to delete temp file:', err);
            });
        });

        console.log('Audio playback started.');

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

function leaveVoiceChannelHandler(message) {
    if (currentConnection) {
        currentConnection.destroy();
        currentConnection = null;
        message.reply('Left the voice channel!');
    }
}

client.login(process.env.DISCORD_BOT_TOKEN);