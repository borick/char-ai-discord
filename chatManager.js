#!/usr/bin/env node
/**
 * manageChats.js
 *
 * A simple command-line script that logs in to the Character AI service,
 * lists active group chats, and disconnects from the character.
 *
 * Ensure you have a .env file (or set environment variables) with:
 *   CHARACTER_AI_TOKEN=your_cainode_token_here
 *   CHARACTER_ID=your_character_id_here
 *
 * Run with: node manageChats.js
 */

const dotenv = require('dotenv');
dotenv.config();

(async () => {
  try {
    // Dynamically import the CAINode class from the cainode package.
    caiClient = new (await import("cainode")).CAINode();
    console.log("Logging in to Character AI...");    
    await caiClient.login(process.env.CHARACTER_AI_TOKEN);

    console.log(`Connecting to character [${process.env.CHARACTER_ID}]...`);
    await caiClient.character.connect(process.env.CHARACTER_ID);

    console.log("Listing active group chats...");
    // List active chats; each chat object is assumed to have a "chatId" property.
    const chats = await caiClient.group_chat.list();
    if (chats && chats.length > 0) {
      chats.forEach((chat, index) => {
        console.log(`${index + 1}. Chat ID: ${chat.chatId}`);
      });
    } else {
      console.log("No active chats found.");
    }

    console.log("Disconnecting from character...");
    await caiClient.character.disconnect(process.env.CHARACTER_ID);
    console.log("Disconnected successfully.");
    process.exit(0);
  } catch (error) {
    console.error("An error occurred:", error);
    process.exit(1);
  }
})();
