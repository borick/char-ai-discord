import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { Buffer } from 'node:buffer';
import fs from 'fs/promises';
import path from 'path';

import dotenv from 'dotenv';
dotenv.config();

const DEBUG_MODE = true;
const DEBUG_LOG_FILE = './audio-debug.log';
const SAVE_RAW_AUDIO = true;

const AUDIO_CONFIG = {
    sampleRate: 48000,
    channels: 2,
    silenceThreshold: -35,  // Adjusted for better speech detection
    minSilenceDuration: 600,
    minSpeechDuration: 1000,
    maxRecordingDuration: 30000,
    frameDuration: 20,
    frameSize: 3840,
    minConsecutiveSilentFrames: 30
};

let connection = null;
let audioBuffer = Buffer.alloc(0);
let isRecording = false;
let recordingTimeout = null;
let audioStream = null;
let recordingStart = 0;

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

class FrameBuffer {
    constructor(frameSize) {
        this.frameSize = frameSize;
        this.buffer = Buffer.alloc(0);
    }

    addData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
    }

    getFrames() {
        const frames = [];
        while (this.buffer.length >= this.frameSize) {
            frames.push(this.buffer.slice(0, this.frameSize));
            this.buffer = this.buffer.slice(this.frameSize);
        }
        return frames;
    }

    clear() {
        this.buffer = Buffer.alloc(0);
    }
}

async function debugLog(message, data = null) {
    if (!DEBUG_MODE) return;
    
    const logEntry = `[${new Date().toISOString()}] ${message}${
        data ? '\n' + JSON.stringify(data, null, 2) : ''
    }\n`;
    
    await fs.appendFile(DEBUG_LOG_FILE, logEntry).catch(console.error);
    console.log(logEntry);
}

function analyzeAudioFrame(pcmBuffer) {
    try {
        const pcmData = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2);
        let sum = 0;
        
        for (const sample of pcmData) {
            sum += Math.abs(sample);
        }

        const avg = sum / pcmData.length;
        const dB = 20 * Math.log10(avg / 32767);
        
        return {
            dB,
            isSilent: dB < AUDIO_CONFIG.silenceThreshold
        };
    } catch (error) {
        debugLog('Audio analysis error', error);
        return { isSilent: true };
    }
}

class VoiceActivityDetector {
    constructor() {
        this.isSpeaking = false;
        this.consecutiveSilentFrames = 0;
        this.consecutiveActiveFrames = 0;
    }

    processFrame(frameAnalysis) {
        debugLog('VAD Processing', {
            dB: frameAnalysis.dB.toFixed(2),
            isSilent: frameAnalysis.isSilent,
            speaking: this.isSpeaking,
            silentFrames: this.consecutiveSilentFrames
        });

        if (frameAnalysis.isSilent) {
            this.consecutiveSilentFrames++;
            this.consecutiveActiveFrames = 0;

            if (this.isSpeaking) {
                const silentDuration = this.consecutiveSilentFrames * AUDIO_CONFIG.frameDuration;
                if (silentDuration >= AUDIO_CONFIG.minSilenceDuration) {
                    debugLog('End of speech detected', {
                        silentDuration,
                        frames: this.consecutiveSilentFrames
                    });
                    this.reset();
                    return 'end';
                }
            }
        } else {
            this.consecutiveSilentFrames = 0;
            this.consecutiveActiveFrames++;

            if (!this.isSpeaking && this.consecutiveActiveFrames >= 2) {
                debugLog('Start of speech detected');
                this.isSpeaking = true;
                return 'start';
            }
        }

        return null;
    }

    reset() {
        this.isSpeaking = false;
        this.consecutiveSilentFrames = 0;
        this.consecutiveActiveFrames = 0;
    }
}

async function convertAudio(input) {
    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    
    const inputPath = path.join(tempDir, `input-${Date.now()}.raw`);
    const outputPath = path.join(tempDir, `output-${Date.now()}.wav`);

    try {
        await fs.writeFile(inputPath, input);
        
        const ffmpeg = spawn(ffmpegStatic, [
            '-y',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            '-i', inputPath,
            '-ar', '16000',
            '-ac', '1',
            '-acodec', 'pcm_s16le',
            outputPath
        ]);

        await new Promise((resolve, reject) => {
            ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(code));
        });

        return fs.readFile(outputPath);
    } finally {
        await fs.rm(inputPath).catch(() => {});
        await fs.rm(outputPath).catch(() => {});
    }
}

client.on('ready', () => {
    debugLog('Bot ready', { tag: client.user.tag });
});

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith('!') || message.author.bot) return;

    const command = message.content.slice(1).toLowerCase().trim();
    debugLog('Command received', { command });

    if (command === 'join') await handleJoin(message);
    if (command === 'leave') handleLeave(message);
});

async function handleJoin(message) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('Join a voice channel first!');

    try {
        if (connection) connection.destroy();
        
        connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
        });

        const vad = new VoiceActivityDetector();
        const frameBuffer = new FrameBuffer(AUDIO_CONFIG.frameSize);

        connection.receiver.speaking.on('speaking', async (userId, speaking) => {
            if (userId !== message.author.id || !speaking) return;

            // Clean up previous stream
            if (audioStream) {
                audioStream.destroy();
                audioBuffer = Buffer.alloc(0);
                frameBuffer.clear();
                clearTimeout(recordingTimeout);
                isRecording = false;
            }

            debugLog('Starting audio capture');
            audioStream = connection.receiver.subscribe(userId, {
                end: { behavior: 'manual' },
                mode: 'pcm'
            });

            audioStream.on('data', (pcmBuffer) => {
                frameBuffer.addData(pcmBuffer);
                
                frameBuffer.getFrames().forEach(frame => {
                    const analysis = analyzeAudioFrame(frame);
                    const result = vad.processFrame(analysis);

                    if (result === 'start') {
                        debugLog('Recording started');
                        isRecording = true;
                        recordingStart = Date.now();
                        audioBuffer = Buffer.alloc(0);
                        recordingTimeout = setTimeout(() => {
                            debugLog('Max duration timeout');
                            audioStream.emit('end');
                        }, AUDIO_CONFIG.maxRecordingDuration);
                    }

                    if (isRecording) {
                        audioBuffer = Buffer.concat([audioBuffer, frame]);

                        // Emergency timeout check
                        if (Date.now() - recordingStart >= AUDIO_CONFIG.maxRecordingDuration) {
                            audioStream.emit('end');
                        }
                    }

                    if (result === 'end') {
                        debugLog('VAD triggered end');
                        audioStream.emit('end');
                    }
                });
            });

            audioStream.on('end', async () => {
                debugLog('Audio stream ended');
                if (!isRecording) return;

                clearTimeout(recordingTimeout);
                isRecording = false;

                try {
                    const duration = Date.now() - recordingStart;
                    if (duration < AUDIO_CONFIG.minSpeechDuration) {
                        debugLog('Discarding short recording');
                        return;
                    }

                    const wavBuffer = await convertAudio(audioBuffer);
                    if (SAVE_RAW_AUDIO) {
                        const filename = `recording-${Date.now()}.wav`;
                        await fs.writeFile(filename, wavBuffer);
                        await message.channel.send(`Recording saved: ${filename}`);
                    }
                } catch (error) {
                    debugLog('Recording processing error', error);
                } finally {
                    audioBuffer = Buffer.alloc(0);
                    frameBuffer.clear();
                }
            });

            audioStream.on('error', (error) => {
                debugLog('Audio stream error', error);
                audioStream.destroy();
            });
        });

        await message.reply(`Joined ${voiceChannel.name}!`);
    } catch (error) {
        debugLog('Join error', error);
        await message.reply('Error joining channel');
    }
}

function handleLeave(message) {
    if (connection) {
        connection.destroy();
        connection = null;
        message.reply('Left voice channel');
    }
}

client.login(process.env.DISCORD_BOT_TOKEN);