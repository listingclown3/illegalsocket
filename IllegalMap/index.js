/// <reference types="../CTAutocomplete" />
/// <reference lib="es2015" />

// --- WebSocket Import and Setup ---
import WebSocket from "WebSocket"; // Make sure WebSocket.js is in the correct path or accessible globally

// --- Other Imports ---
import Dungeon from "../BloomCore/dungeons/Dungeon";
import Config, { borderScaleGui, editDungeonInfoGui, mapEditGui } from "./utils/Config";
import "./extra/ScoreMilestones";
import "./extra/Mimic";
import "./extra/StarMobStuff";
import "./extra/WitherDoorEsp"; // Ensure this is imported *after* WebSocket setup if it needs the ws instance immediately (though it uses it in tick)
import "./utils/UpdateChecker";
import "./extra/FirstInstall";
import "./extra/VisitedCommand";
import "./extra/DungeonLoggerNew";
import "./extra/DungeonViewer";
import "./extra/NewRoomCommand";
import "./utils/guiStuff";
import DmapDungeon from "./components/DmapDungeon";
import { renderInfoSeparate, renderMap, renderMapEditGui } from "./utils/rendering";

// --- WebSocket Instance and State ---
// Use "ws://localhost:8080" or pull from Config if you make it configurable
const wsServerUrl = "ws://localhost:8080";
let ws = null;
let isWsOpen = false;

// Function to safely send messages, checking connection state
export const sendWebSocketMessage = (message) => {
    if (ws && isWsOpen) {
        try {
            ws.send(message);
        } catch (e) {
            console.error("WebSocket send error: " + e);
            // Optionally handle the error, e.g., try reconnecting or disable sending
        }
    } else {
        // Optionally log that the message wasn't sent because the socket isn't open
        // print("Debug: WebSocket not open, message not sent.");
    }
};

// Function to initialize WebSocket
const initializeWebSocket = () => {
    if (ws) {
        try {
            ws.close(); // Close existing connection if any
        } catch (e) {} // Ignore errors during close
    }

    print(`Dmap: Attempting to connect to WebSocket at ${wsServerUrl}...`);
    ws = new WebSocket(wsServerUrl);

    ws.onOpen = () => {
        print("Dmap: WebSocket connection opened.");
        isWsOpen = true;
        // You could send an initial message here if needed
        // sendWebSocketMessage(JSON.stringify({ type: "status", message: "ChatTriggers mod connected" }));
    };

    ws.onMessage = (msg) => {
        print("Dmap: WebSocket message received: " + msg);
        // Handle messages from the server if necessary
    };

    ws.onError = (exception) => {
        console.error("Dmap: WebSocket error: " + exception);
        isWsOpen = false;
        // Optional: Add automatic reconnection logic here after a delay
        // setTimeout(initializeWebSocket, 5000); // Try to reconnect after 5 seconds
    };

    ws.onClose = (code, reason) => {
        print(`Dmap: WebSocket connection closed. Code: ${code}, Reason: ${reason}`);
        isWsOpen = false;
        ws = null; // Clear the instance
        // Optional: Add automatic reconnection logic here after a delay
        // setTimeout(initializeWebSocket, 5000); // Try to reconnect after 5 seconds
    };

    try {
        ws.connect();
    } catch (e) {
        console.error("Dmap: WebSocket connection failed immediately: " + e);
        ws = null;
        isWsOpen = false;
        // Optional: Schedule a reconnection attempt
        // setTimeout(initializeWebSocket, 5000);
    }
};

// Export the state check if needed directly elsewhere (though sendWebSocketMessage is preferred)
export const isWebSocketOpen = () => isWsOpen;

// --- Initialize WebSocket on script load ---
initializeWebSocket();
// You might want to add a command to manually reconnect, e.g., /dmap wsconnect
// register("command", initializeWebSocket).setName("dmapwsreconnect");

// --- Rest of your index.js code ---

register("command", (...args) => {
    if (!args || !args.length || !args[0]) return Config().getConfig().openGui();

    // Used for debugging
    if (args[0] == "reset") DmapDungeon.reset();
    if (args[0] === "wsreconnect") { // Example command to reconnect manually
        initializeWebSocket();
        ChatLib.chat("&aAttempting WebSocket reconnection...");
    }

}).setName("dmap");

// Rendering
register("renderOverlay", () => {
    // Lets the separate info continue to render even when the toggle for the main map rendering is set to false
    if (editDungeonInfoGui.isOpen() || (Config().dungeonInfo == 1 || Config().dungeonInfo == 3) && !Config().enabled) {
        renderInfoSeparate();
    }

    if (mapEditGui.isOpen() || borderScaleGui.isOpen()) {
        renderMap();
        renderMapEditGui();
        return;
    }

    if (!Config().enabled || !Dungeon.inDungeon) return;
    if (Config().hideInBoss && Dungeon.bossEntry) return;

    renderMap();
});

// Ensure WebSocket connection is closed cleanly when CT reloads/unloads
register("gameUnload", () => {
    if (ws) {
        print("Dmap: Closing WebSocket connection on game unload.");
        isWsOpen = false;
        try {
            ws.close();
        } catch(e) {}
        ws = null;
    }
});