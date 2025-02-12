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

    if (process.argv[2] == "delete_all_rooms") {
      
      console.log("Deleting all group chats...");

      const chats = await caiClient.group_chat.list();
      const chatRooms = chats["rooms"];
      console.log(chatRooms);
      chatRooms.forEach((value, index) => {
        console.log("deleting room: ", value.id);
        caiClient.group_chat.delete(value.id);
      });

    } else if (process.argv[2] == "list_rooms") {
      
      console.log("Listing active group chats...");
      
      const chats = await caiClient.group_chat.list();
      const chatRooms = chats["rooms"];
      if (chatRooms && chatRooms.length > 0) {
        chatRooms.forEach((rooms, index) => {
          console.log(`${index + 1}. Chat ID: ${rooms.id}`);
        });
      } else {
        console.log("No active chats found.");
      }
    } else {
      console.log("Invalid command line argument.");
    }

  } catch (error) {
    console.error("An error occurred:", error);
    process.exit(1);
  }
})();
