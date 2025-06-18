/// <reference types="../../CTAutocomplete" />
/// <reference lib="es2015" />

import Dungeon from "../../BloomCore/dungeons/Dungeon";
import Config from "../utils/Config";
import DmapDungeon from "../components/DmapDungeon";
import { DoorTypes } from "../utils/utils";
import { registerWhen } from "../../BloomCore/utils/Utils";
import Room from "../components/Room"; // Assuming Room class is available
import { renderBoxOutline } from "../../BloomCore/RenderUtils";


// --- Import the WebSocket send function ---
// Make sure the path is correct relative to WitherDoorEsp.js
import { sendWebSocketMessage } from "../index";

// Add necessary Java types
const AirBlockID = 0; // Minecraft Air block ID

// --- Configuration & Constants ---
const TypesToESP = [DoorTypes.WITHER, DoorTypes.BLOOD];
const FLOOR_Y = 69; // Adjust if the standard dungeon floor level is different

let doorsToRender = []; // Array to hold door objects with calculated foot coords
let lastSentDoorsJson = null; // Store the last JSON string sent via WebSocket

/**
 * Calculates the optimal foot coordinates for approaching a door using block checking.
 * It checks blocks adjacent to the door to find open sides and selects the best one.
 *
 * @param {{x: number, z: number}} doorCoords The center coordinates of the door structure at floor level.
 * @param {number} floorY The Y-level of the dungeon floor.
 * @param {{x: number, y: number, z: number}} [playerPos=null] The current player position (optional, used for tie-breaking).
 * @returns {{footX: number, footY: number, footZ: number} | null} The coordinates of the optimal foot position, or null if none found.
 */
const calculateFootCoordsWithBlockCheck = (doorCoords, floorY, playerPos = null) => {
    // --- 1. Input Validation and Setup ---
    if (!doorCoords || doorCoords.x === undefined || doorCoords.z === undefined) {
        console.error("Dmap (BlockCheck): calculateFootCoords called with invalid doorCoords.");
        return null;
    }

    // Ensure we're working with integer coordinates for block checking
    const doorBlockX = Math.floor(doorCoords.x);
    const doorBlockZ = Math.floor(doorCoords.z);

    // Get player position if not provided (use integer coords for distance checks)
    if (!playerPos) {
        playerPos = {
            x: Math.floor(Player.getX()),
            y: Math.floor(Player.getY()),
            z: Math.floor(Player.getZ())
        };
    } else {
         playerPos = {
            x: Math.floor(playerPos.x),
            y: Math.floor(playerPos.y),
            z: Math.floor(playerPos.z)
        };
    }

    // Helper to check if a block is air (handles potential errors)
    const isBlockAir = (x, y, z) => {
        try {
            // Use World.getBlockAt for basic type checking ID
            return World.getBlockAt(x, y, z).type.getID() === AirBlockID;
        } catch (e) {
            // Use console.error for consistency if preferred
            // console.error(`Dmap (BlockCheck): Error checking block at ${x},${y},${z}: ${e}`);
            ChatLib.chat(`&cDmap (BlockCheck): Error checking block at ${x},${y},${z}: ${e}`); // Log error to chat
            return false; // Assume solid if error
        }
    };

    // --- 2. Check Adjacent Blocks for Air ---
    // Check 2 blocks away for clearance at floor and head height (like Java example)
    const checks = {
        // Check North (Z-2)
        north: isBlockAir(doorBlockX, floorY, doorBlockZ - 2) && isBlockAir(doorBlockX, floorY + 1, doorBlockZ - 2),
        // Check South (Z+2)
        south: isBlockAir(doorBlockX, floorY, doorBlockZ + 2) && isBlockAir(doorBlockX, floorY + 1, doorBlockZ + 2),
        // Check East (X+2)
        east: isBlockAir(doorBlockX + 2, floorY, doorBlockZ) && isBlockAir(doorBlockX + 2, floorY + 1, doorBlockZ),
         // Check West (X-2)
        west: isBlockAir(doorBlockX - 2, floorY, doorBlockZ) && isBlockAir(doorBlockX - 2, floorY + 1, doorBlockZ)
    };

    // --- 3. Generate Candidate Foot Positions ---
    // Target blocks are 1 step away from the door center in open directions.
    let candidates = [];
    if (checks.north) candidates.push({ footX: doorBlockX + 2, footY: floorY, footZ: doorBlockZ - 3, side: "north" });
    if (checks.south) candidates.push({ footX: doorBlockX - 2, footY: floorY, footZ: doorBlockZ + 3, side: "south" });
    if (checks.east) candidates.push({ footX: doorBlockX + 3, footY: floorY, footZ: doorBlockZ - 2, side: "east" });
    if (checks.west) candidates.push({ footX: doorBlockX - 3, footY: floorY, footZ: doorBlockZ - 2, side: "west" });

    // --- 4. Select the Best Candidate ---
    if (candidates.length === 0) {
        // Log an issue if no open side is found
        // console.log(`Dmap (BlockCheck): No open side found via block check for door at ${doorBlockX}, ${doorBlockZ}.`);
        return null; // Indicate failure to find a suitable spot
    }

    if (candidates.length === 1) {
        // Only one valid direction, return it
        return candidates[0];
    }

    // Multiple candidates, use player proximity as tie-breaker
    let bestPosition = null;
    let closestDistanceSq = Infinity; // Use squared distance

    candidates.forEach(pos => {
        const dx = playerPos.x - pos.footX;
        const dz = playerPos.z - pos.footZ;
        const distanceSq = dx*dx + dz*dz;

        if (distanceSq < closestDistanceSq) {
            closestDistanceSq = distanceSq;
            bestPosition = pos;
        }
    });

    return bestPosition;
};


/**
 * Recursively searches for Wither/Blood doors starting from a room.
 * Adds calculated foot coordinates to the door object.
 * @param {Room} room The room object to search from.
 * @param {number} doorsFound Current count of relevant doors found down this path.
 * @returns {boolean} True if the search path should terminate (e.g., found 2 doors).
 */
const searchForWitherDoors = (room, doorsFound = 0) => {
    // Termination condition (adjust if needed, e.g., remove if you want *all* doors)
    if (doorsFound >= 2) return true;

    let pathShouldTerminate = false;

    // Check if room or room.children is invalid before iterating
    if (!room || !room.children || !Array.isArray(room.children)) {
        // console.error("Dmap: searchForWitherDoors called with invalid room or children.");
        return false; // Cannot search further down this path
    }

    for (let child of room.children) {
        // Ensure child is a valid room object before proceeding
        if (!child || !child.name) continue; // Basic check for a valid room object

        let door = DmapDungeon.getDoorBetweenRooms(room, child);

        // Check if it's a valid door of the type we want and not opened
        if (!door || !TypesToESP.includes(door.type) || door.opened) continue;

        // *** Use the new block checking function ***
        const footCoords = calculateFootCoordsWithBlockCheck(
            { x: door.x, z: door.z }, // Pass door center coords
            FLOOR_Y                   // Pass floor Y level
            // Player position is automatically fetched inside if needed for tie-breaking
        );

        if (footCoords) {
            // Attach calculated foot coordinates to the door object
            door.footX = footCoords.footX;
            door.footY = footCoords.footY;
            door.footZ = footCoords.footZ;
            // Optional: Log success
            // console.log(`Dmap: Foot coords for door (${door.x}, ${door.z}) set to (${door.footX}, ${door.footY}, ${door.footZ})`);
        } else {
            // Handle case where calculation failed - log and use fallback
            console.warn(`Dmap: Failed to calculate foot coords via block check for door between ${room.name} and ${child.name} at (${door.x}, ${door.z}). Using fallback.`);
            door.footX = door.x; // Fallback to door center X
            door.footY = FLOOR_Y;// Fallback Y
            door.footZ = door.z; // Fallback to door center Z
        }

        // Add the (potentially modified) door object to the render list
        doorsToRender.push(door);
        let newDoorsFound = doorsFound + 1;

        // Recursively search children, check if that branch terminated
        if (searchForWitherDoors(child, newDoorsFound)) {
            pathShouldTerminate = true;
        }
    }

    return pathShouldTerminate; // Return whether this branch finished its search
};


// --- Tick Handler ---
register("command", () => {
    isAutoGotoEnabled = !isAutoGotoEnabled; // Toggle the state
    ChatLib.chat(`&aDmap: Auto GOTO to first door ${isAutoGotoEnabled ? "&aenabled" : "&cdisabled"}.`);

    // If just enabled, try to send GOTO immediately if a target exists
    if (isAutoGotoEnabled) {
        lastSentGotoCoords = null; // Reset last sent coords to force sending if target exists
        // We'll let the next tick handle the actual sending logic
    } else {
         lastSentGotoCoords = null; // Also reset when disabling
         // Optional: Send a STOP command immediately when disabling?
         // const stopCommand = { type: "action", action: "STOP", sender: "ChatTriggers", data: {} };
         // sendWebSocketMessage(JSON.stringify(stopCommand));
    }
}).setName("gotodoor").setAliases(["dmapgoto"]); // Choose command name and aliases


// --- Tick Handler ---
register("tick", () => {
    // --- Conditions Check ---
    const shouldBeActive = Config().witherDoorEsp && Dungeon.inDungeon && !Dungeon.bossEntry;

    if (!shouldBeActive) {
        if (doorsToRender.length > 0 || lastSentDoorsJson !== null) {
            doorsToRender = [];
            lastSentDoorsJson = null;
        }
        // Also reset GOTO state if inactive
        // isAutoGotoEnabled = false; // Decide if you want it to turn off automatically
        lastSentGotoCoords = null;
        return;
    }

    const currentRoom = DmapDungeon.getCurrentRoom();
    if (!currentRoom) {
         if (doorsToRender.length > 0 || lastSentDoorsJson !== null) {
            doorsToRender = [];
            lastSentDoorsJson = null;
        }
        lastSentGotoCoords = null; // Reset GOTO state if no room
        return;
    }

    // --- Update door list ---
    doorsToRender = [];
    searchForWitherDoors(currentRoom);

    // --- Prepare and Send doorLocations data via WebSocket (as before) ---
    const doorsData = doorsToRender.map(door => ({
        x: door.x, z: door.z, type: DoorTypes[door.type] || door.type, opened: door.opened,
        footX: door.footX, footY: door.footY, footZ: door.footZ
    })).filter(d => d.footX !== undefined && d.footZ !== undefined);

    if (doorsData.length > 0) {
        const currentDoorsJson = JSON.stringify({ type: "doorLocations", doors: doorsData });
        if (currentDoorsJson !== lastSentDoorsJson) {
            sendWebSocketMessage(currentDoorsJson);
            lastSentDoorsJson = currentDoorsJson;
        }
    } else {
        if (lastSentDoorsJson !== null) {
             const emptyListJson = JSON.stringify({ type: "doorLocations", doors: [] });
             if (lastSentDoorsJson !== emptyListJson) {
                 sendWebSocketMessage(emptyListJson);
                 lastSentDoorsJson = emptyListJson;
             }
        }
    }

    // --- Auto GOTO Logic ---
    let currentTargetDoor = null;
    if (doorsData.length > 0) { // Use doorsData which is already filtered for valid coords
        currentTargetDoor = doorsData[0]; // Target the first door with valid coords
    }

    if (isAutoGotoEnabled) {
        let shouldSendGoto = false;
        let newGotoCoords = null;

        if (currentTargetDoor) {
            // We already know footX/Y/Z are valid from the filter above
            newGotoCoords = { x: currentTargetDoor.footX, y: currentTargetDoor.footY, z: currentTargetDoor.footZ };

            // Check if target is new or different from the last one sent
            if (!lastSentGotoCoords ||
                lastSentGotoCoords.x !== newGotoCoords.x ||
                lastSentGotoCoords.y !== newGotoCoords.y ||
                lastSentGotoCoords.z !== newGotoCoords.z) {
                shouldSendGoto = true;
            }
        } else {
            // No current target door, clear the last sent coords state
            if (lastSentGotoCoords !== null) {
                 lastSentGotoCoords = null;
                 // console.log("Dmap: Target door lost, stopping GOTO updates.");
                 // Optional: Send STOP command here?
            }
        }

        // Send GOTO if needed
        if (shouldSendGoto && newGotoCoords) {
            const gotoCommand = {
                type: "action",
                action: "GOTO",
                sender: "ChatTriggers", // Identify sender
                data: newGotoCoords
            };
            sendWebSocketMessage(JSON.stringify(gotoCommand));
            lastSentGotoCoords = newGotoCoords; // Update the state
            // console.log("Dmap: Sent GOTO command for new target."); // Debug log
        }
    } else {
        // If toggle is disabled, ensure state is reset (already handled by command/inactive checks)
        // lastSentGotoCoords = null; // This ensures it sends on re-enable
    }
});

// --- Rendering Logic (Uses original door.x, door.z for the visual box) ---
const renderDoor = (door) => {
    const color = Config().witherDoorEspColor
    const [r, g, b] = [color[0] / 255, color[1] / 255, color[2] / 255]
    let x = door.x
    let z = door.z
    renderBoxOutline(x+0.5, 69, z+0.5, 3, 4, r, g, b, 1, 2, true)

}

registerWhen(register("renderWorld", () => {
    doorsToRender.forEach(door => renderDoor(door));
}), () => Config().witherDoorEsp && doorsToRender.length > 0 && Dungeon.inDungeon && !Dungeon.bossEntry);

// World Unload (keep as before)
register("worldUnload", () => {
    doorsToRender = [];
    lastSentDoorsJson = null;
    isAutoGotoEnabled = false; // Reset toggle on world unload
    lastSentGotoCoords = null;
});
