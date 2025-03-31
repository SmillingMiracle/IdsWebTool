const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const WebSocket = require('ws');
const { exec } = require('child_process');
const os = require('os');

let mainWindow; // Reference to the main Electron window
let wss; // WebSocket server instance

/**
 * Application ready event
 * Initializes the main Electron window and WebSocket server
 */
app.on('ready', () => {
    console.log("Electron application is ready!");

    // Create the main Electron window
    mainWindow = createMainWindow();

    // Initialize WebSocket server for communication
    initializeWebSocketServer();
});

/**
 * Creates the main Electron window
 * @returns {BrowserWindow} - The created main BrowserWindow instance
 */
function createMainWindow() {
    const window = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    // Load a placeholder HTML into the window
    window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(generateHTMLContent()));
    console.log("Main window has been initialized");

    return window;
}

/**
 * Generates placeholder HTML content to display in the window
 * @returns {string} - HTML content string
 */
function generateHTMLContent() {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>IPS System</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                text-align: center;
                background-color: #f4f4f4;
                color: #333;
                padding: 50px;
            }
            .container {
                background: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
            }
            h1 { color: #0a8175; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>IPS Agent is working...</h1>
        </div>
    </body>
    </html>`;
}

/**
 * Initializes the WebSocket server and handles its events
 */
function initializeWebSocketServer() {
    wss = new WebSocket.Server({ port: 8081 });
    console.log("WebSocket server started on port 8081");

    wss.on('connection', (ws) => {
        console.log("WebSocket client connected");

        // Handle messages from WebSocket clients
        ws.on('message', (message) => handleWebSocketMessage(message, ws));
        ws.on('close', () => console.log("WebSocket connection closed"));
        ws.on('error', (error) => console.error("WebSocket error:", error));
    });
}

/**
 * Handles incoming WebSocket messages
 * @param {string} message - The received message
 * @param {WebSocket} ws - The WebSocket client instance
 */
async function handleWebSocketMessage(message, ws) {
    try {
        const data = JSON.parse(message);

        if (data.type === 'filePath') {
            console.log("Received folder path from WebSocket client:", data.filePath);
            const result = await createAndSendZip(data.filePath, null);
            ws.send(JSON.stringify({ type: result.success ? 'success' : 'error', message: result.message }));
        } else if (data.action === 'sendDeviceName' && data.deviceName) {
            handleDeviceNameAction(data.deviceName, ws);
        }
    } catch (error) {
        console.error("Error processing WebSocket message:", error);
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
}

/**
 * Handles the `sendDeviceName` action from a WebSocket client
 * @param {string} deviceName - The name of the device
 * @param {WebSocket} ws - The WebSocket client instance
 */
function handleDeviceNameAction(deviceName, ws) {
    const fileName = "ASMP start.bat";
    findInCommonDirs(fileName, (directory) => {
        if (directory) {
            ws.send(JSON.stringify({ action: "fileFound", fileName, directory }));
            createAndSendZip(directory, deviceName);
        } else {
            findFileOnDisk(fileName, (fullPath) => {
                if (fullPath) {
                    ws.send(JSON.stringify({ action: "fileFound", fileName, directory: fullPath }));
                    createAndSendZip(fullPath, deviceName);
                } else {
                    ws.send(JSON.stringify({ action: "fileNotFound", fileName }));
                }
            });
        }
    });
}

/**
 * Creates and sends a filtered ZIP archive
 * @param {string} baseDir - Base directory containing files to be zipped
 * @param {string} [deviceName] - (Optional) Device name used for filtering files
 * @returns {Object} - Result of the operation
 */
async function createAndSendZip(baseDir, deviceName) {
    try {
        const archive = archiver('zip', { zlib: { level: 5 } });
        const outputPath = path.join(baseDir, 'filtered-archive.zip');
        const output = fs.createWriteStream(outputPath);

        archive.on('progress', (progress) =>
            console.log(`ZIP Progress: ${progress.entries.processed} files, ${progress.fs.processedBytes} bytes`));

        output.on('close', () => {
            const zipBuffer = fs.readFileSync(outputPath);
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) client.send(zipBuffer);
            });
            console.log(`ZIP successfully sent: ${outputPath}`);
        });

        archive.pipe(output);

        // Add filtered `.txt` files based on the device name
        addFilteredFilesToArchive(baseDir, 'out', '.txt', deviceName, archive);
        addFilteredFilesToArchive(baseDir, '_inputs_severin/tables', '.txt', deviceName, archive);
        addFilteredFilesToArchive(baseDir, 'temp', '.net', deviceName, archive);

        await archive.finalize();
        return { success: true, message: "Filtered ZIP successfully created and sent." };
    } catch (error) {
        console.error("ZIP creation failed:", error);
        return { success: false, message: error.message };
    }
}

/**
 * Adds filtered files to the archive
 * @param {string} baseDir - Base directory
 * @param {string} folder - Target folder
 * @param {string} extension - File extension to filter
 * @param {string} deviceName - Device name to match
 * @param {archiver.Archiver} archive - Archiver instance
 */
function addFilteredFilesToArchive(baseDir, folder, extension, deviceName, archive) {
    const dirPath = path.join(baseDir, folder);
    if (fs.existsSync(dirPath)) {
        fs.readdirSync(dirPath)
            .filter((file) => file.endsWith(extension))
            .forEach((file) => {
                const filePath = path.join(dirPath, file);
                const content = fs.readFileSync(filePath, 'utf8');
                if (folder === 'temp'){
                    archive.file(filePath, { name: path.join(folder, file) });
                }else if ((folder === 'out' || folder === '_inputs_severin/tables') && file.includes(deviceName)){
                    archive.file(filePath, { name: path.join(folder, file) });
                }
            });
    }
}

/**
 * Finds a file in common directories
 * @param {string} fileName - Name of the file to search for
 * @param {Function} callback - Callback function to return results
 */
function findInCommonDirs(fileName, callback) {
    const directories = getCommonDirectories();
    let foundPath = null;
    let checked = 0;

    directories.forEach((dir) => {
        exec(`where /r "${dir}" "${fileName}"`, (error, stdout) => {
            checked++;
            if (!error && stdout.trim()) {
                foundPath = path.dirname(stdout.split("\n")[0].trim());
            }
            if (checked === directories.length) callback(foundPath);
        });
    });
}

/**
 * Gets the list of common directories to search in
 * @returns {string[]} - List of common directories
 */
function getCommonDirectories() {
    const userDir = os.homedir();
    return [
        path.join(userDir, "Desktop"),
        path.join(userDir, "Downloads"),
        path.join(userDir, "Documents"),
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        "C:\\",
    ];
}

/**
 * Searches for a file on the entire disk
 * @param {string} fileName - Name of the file
 * @param {Function} callback - Callback function to return results
 */
function findFileOnDisk(fileName, callback) {
    const command = `powershell -Command "Get-ChildItem -Path C:\\ -Recurse -Filter '${fileName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName"`;
    exec(command, { maxBuffer: 1024 * 1000 }, (error, stdout) => {
        if (error) {
            console.error("Disk search error:", error);
            callback(null);
            return;
        }
        const files = stdout.trim().split("\r\n").filter(Boolean);
        callback(files.length > 0 ? path.dirname(files[0]) : null);
    });
}
