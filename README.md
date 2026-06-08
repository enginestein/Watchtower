# Watchtower

A self-hosted CCTV system (by **Enginestein**) using an ESP32-CAM for video capture and a Node.js server for motion detection, human recognition, recording, and live monitoring via a dark-mode web dashboard.

## Architecture

```
ESP32-CAM ──MJPEG/HTTP──> Node.js Server ──WebSocket──> Browser Dashboard
                              │
                              ├── SQLite (recordings, events, logs)
                              ├── Sharp (motion detection)
                              └── TensorFlow.js (human detection)
```

- **ESP32-CAM** streams MJPEG over HTTP, accepts runtime settings commands (resolution, quality, mirror, flip, flash, brightness, contrast).
- **Node.js server** polls frames, detects motion (frame diffing via Sharp), detects humans (COCO-SSD), records segments, stores events in SQLite.
- **Browser dashboard** single-page app (HTML/CSS/JS) with live view, event browsing, alerts, camera settings, system logs.

## Project Structure

```
cctv/
├── server.js                        # Express + Socket.IO server
├── config.json                      # System & camera configuration
├── src/
│   ├── camera-manager.js            # Camera lifecycle, frame polling, settings
│   ├── motion-detector.js           # Frame-diffing motion detection
│   ├── human-detector.js            # TensorFlow.js COCO-SSD detection
│   ├── recorder.js                  # Frame capture, session management, cleanup
│   ├── database.js                  # SQLite schema & queries
│   ├── logger.js                    # File + DB + console logging
│   └── alert-manager.js             # Deduplicated alerts, WS push
├── public/
│   ├── index.html                   # SPA dashboard
│   └── css/style.css                # Dark theme
├── esp32-sketch/
│   └── ESP32_CAM_Streamer/
│       └── ESP32_CAM_Streamer.ino   # ESP32-CAM firmware
├── recordings/                      # Recording output (created at runtime)
├── snapshots/                       # Motion/human detection snapshots
└── logs/                            # Rotating log files
```

## Hardware Requirements

- ESP32-CAM module (AI-Thinker or compatible with OV2640)
- 5V power supply (2A minimum; the ESP32-CAM draws ~300mA with flash off)
- Micro-USB to UART programmer (for initial firmware upload)
- Optional: LED on GPIO 4 for flash (see safety notes below)

## Setup

### 1. ESP32-CAM Firmware

1. Open `esp32-sketch/ESP32_CAM_Streamer/ESP32_CAM_Streamer.ino` in Arduino IDE.
2. Install ESP32 board support (https://github.com/espressif/arduino-esp32).
3. Install the `esp32-camera` library.
4. Set your WiFi credentials in the sketch:
   ```cpp
   const char* WIFI_SSID = "YourSSID";
   const char* WIFI_PASSWORD = "YourPassword";
   ```
5. Select board: **AI Thinker ESP32-CAM**.
6. Set upload speed: **115200**.
7. Connect GPIO 0 to GND, power cycle, click Upload.
8. After upload, disconnect GPIO 0 from GND and reset.
9. Check the Serial Monitor for the assigned IP address.

### 2. Node.js Server

```bash
# Install dependencies
npm install

# Configure cameras
# Edit config.json — set your ESP32-CAM's IP address in cameras[].stream_url

# Start the server
node server.js
```

The server listens on `http://0.0.0.0:3000` by default.

### 3. Dashboard

Open `http://<server-ip>:3000` in a browser.

## Configuration

### config.json

| Key | Description |
|-----|-------------|
| `server.port` | HTTP server port |
| `server.host` | Bind address |
| `cameras[].id` | Numeric camera ID |
| `cameras[].name` | Display name |
| `cameras[].stream_url` | MJPEG stream URL (e.g. `http://192.168.1.100:81/stream`) |
| `cameras[].snapshot_url` | Snapshot URL (e.g. `http://192.168.1.100:81/capture`) |
| `cameras[].config_url` | Base URL for settings commands (e.g. `http://192.168.1.100:81`) |
| `cameras[].fps` | Polling frame rate |
| `motion_detection.threshold` | Sensitivity threshold (lower = more sensitive) |
| `motion_detection.sensitivity` | Pixel change sensitivity |
| `human_detection.confidence_threshold` | Minimum confidence for human detection |
| `recording.retention_days` | Days to keep recordings before cleanup |
| `recording.continuous` | Continous recording vs. motion-only |
| `storage.recordings_path` | Directory for recorded segments |
| `storage.snapshots_path` | Directory for event snapshots |

### Camera Settings (Runtime)

Settings can be changed via the dashboard (Camera Settings modal) without reflashing the ESP32:

- **Resolution**: QVGA (320×240), VGA (640×480), SVGA (800×600), HD (1280×720), SXGA (1280×1024), UXGA (1600×1200)
- **JPEG Quality**: 4 (best) to 63 (worst)
- **Horizontal Mirror / Vertical Flip**
- **Flash LED**: Requires hardware support (see Flash Safety below)
- **Brightness / Contrast**: -2 to 2

## Flash Safety

The ESP32-CAM's voltage regulator cannot supply the current needed by a typical high-brightness LED (GPIO 4) without risking brownouts, WiFi disconnects, or camera freezes.

- The flash GPIO is **commented out** by default (`// #define LED_FLASH 4`).
- To enable, uncomment that line **only if** you have verified your board's regulator can handle the load, or if you are using an external LED with a transistor driver.
- The firmware enforces a **30-second auto-shutdown** as a safety measure.
- A warning banner appears in the dashboard when flash is enabled.

## API

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/stats` | System statistics |
| `GET` | `/api/cameras` | List all cameras |
| `GET` | `/api/cameras/:id` | Get camera details |
| `POST` | `/api/cameras/:id/test` | Test camera connection |
| `GET` | `/api/cameras/:id/settings` | Get camera settings (from ESP32 or stored defaults) |
| `PUT` | `/api/cameras/:id/settings` | Apply camera settings to ESP32 |
| `GET` | `/api/cameras/:id/stream` | Raw MJPEG stream from ESP32 |
| `GET` | `/api/recordings` | List recordings |
| `GET` | `/api/recordings/:id` | Get recording details |
| `DELETE` | `/api/recordings/:id` | Delete a recording |
| `GET` | `/api/motion/events` | List motion events |
| `GET` | `/api/human-detections` | List human detections |
| `GET` | `/api/alerts` | List alerts |
| `PUT` | `/api/alerts/:id/read` | Mark alert as read |
| `GET` | `/api/logs` | System logs |
| `PUT` | `/api/motion/settings` | Update motion detection settings |
| `PUT` | `/api/human-detection/settings` | Update human detection settings |
| `GET` | `/api/config` | Get system config |

### WebSocket Events

The server pushes real-time events via Socket.IO:

| Event | Payload | Description |
|-------|---------|-------------|
| `frame` | `{cameraId, frame (base64), camera}` | Live video frame |
| `motion` | `{cameraId, camera, event}` | Motion detected |
| `human` | `{cameraId, camera, detection}` | Human detected |
| `alert` | `{alert}` | New alert notification |
| `camera-status` | `{cameraId, status}` | Camera connection state |
| `recording` | `{recording}` | Recording session created |

## ESP32-CAM Endpoints

The ESP32-CAM exposes these endpoints on its HTTP server:

| Path | Parameters | Description |
|------|-----------|-------------|
| `/stream` | — | MJPEG live stream |
| `/capture` | — | Single JPEG snapshot |
| `/status` | — | JSON with current camera settings |
| `/signal` | — | WiFi RSSI information |
| `/resolution` | `res` (qvga/vga/svga/hd/sxga/uxga) | Change resolution |
| `/quality` | `q` (4–63) | Set JPEG quality |
| `/mirror` | `h` (0/1) | Horizontal mirror |
| `/flip` | `v` (0/1) | Vertical flip |
| `/flash` | `en` (0/1) | Flash LED on/off |
| `/brightness` | `val` (-2–2) | Set brightness |
| `/contrast` | `val` (-2–2) | Set contrast |

## Notes

- The ESP32 sketch uses a raw `WiFiServer` (not Arduino `WebServer`) so that settings commands are processed even while a browser is streaming MJPEG. The Arduino `WebServer` is single-client and blocks settings requests during a stream.
- TensorFlow.js model loading is deferred — the server starts immediately and enables human detection once the model is ready.
- Motion detection uses grayscale frame differencing via Sharp, with configurable threshold and cooldown.
- Frame buffers are kept per-camera (50 frames) for recording and analysis.
