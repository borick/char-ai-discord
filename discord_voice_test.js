import { config } from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';
import fs from 'fs';
import { pipeline } from 'stream';

// Load environment variables from .env file
config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

let connection;

client.once('ready', () => {
    console.log('Ready!');
});

client.on('messageCreate', async (message) => {
    if (message.content === '!join') {
        if (!message.member.voice.channel) {
            return message.reply('You need to be in a voice channel first!');
        }

        const channel = message.member.voice.channel;

        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: false,  // Ensure the bot is not deafened when it joins
        });

        connection.on(VoiceConnectionStatus.Ready, () => {
            console.log('The bot has connected to the channel!');

            // Capture audio and write to file
            const receiver = connection.receiver;
            const userId = ''; // Leave empty to record all users

            const audioStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.AfterSilence,
                    duration: 1000 // Duration of silence to end the stream
                }
            });

            audioStream.on('error', console.error);
            audioStream.on('data', () => console.log('Receiving audio data...'));

            let silenceTime = 0;
            let fileNumber = 0;
            let writeStream = fs.createWriteStream(`./recording-${fileNumber}.pcm`);

            audioStream.on('data', (chunk) => {
                if (chunk.length === 0) {
                    silenceTime += 1;
                    if (silenceTime > 5) { // Adjust the threshold as needed
                        fileNumber += 1;
                        writeStream.close();
                        writeStream = fs.createWriteStream(`./recording-${fileNumber}.pcm`);
                        silenceTime = 0;
                    }
                } else {
                    silenceTime = 0;
                }
                writeStream.write(chunk);
            });

            audioStream.on('end', () => {
                writeStream.close();
                console.log('Audio stream ended.');
            });
        });

        connection.on('error', console.error);
    }
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down...');
    if (connection) {
        connection.destroy();
        console.log('Disconnected from voice channel.');
    }
    client.destroy();
    process.exit();
});

client.login(process.env.DISCORD_BOT_TOKEN);
