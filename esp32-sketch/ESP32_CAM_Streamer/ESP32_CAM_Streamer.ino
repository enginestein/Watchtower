/*
  ESP32-CAM Watchtower Streamer
  RAW WiFiServer implementation -> handles MJPEG streaming and
  settings commands concurrently in the main loop.
  No dependency on Arduino WebServer (single-client limitation).

  Hardware: AI-Thinker ESP32-CAM module (OV2640 camera)

  Connections:
    - AI-Thinker ESP32-CAM: Upload with GPIO0 LOW, then set HIGH for run
    - FREENOVE ESP32-CAM: May use different pins, adjust accordingly
*/

#include "esp_camera.h"
#include <WiFi.h>

// ===== CONFIGURATION =====
const char* WIFI_SSID = "SSID";
const char* WIFI_PASSWORD = "PASSWORD";
const uint16_t SERVER_PORT = 81;

// ===== PIN DEFINITIONS =====
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// LED Flash (GPIO 4 on most ESP32-CAM boards -> COMMENTED OUT by default)
// Uncomment if your board supports it and you accept the power risks.
// #define LED_FLASH 4

#ifdef LED_FLASH
  bool flashState = false;
  unsigned long flashStartTime = 0;
  const unsigned long FLASH_MAX_DURATION = 30000;
#endif

// ===== MJPEG Stream =====
static const char* STREAM_BOUNDARY = "frame";
static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace; boundary=frame";

WiFiServer server(SERVER_PORT);

#define MAX_STREAM_CLIENTS 4
WiFiClient streamClients[MAX_STREAM_CLIENTS];

unsigned long lastFrameTime = 0;
const unsigned long FRAME_INTERVAL = 50;  // ~20 FPS

#define REQUEST_BUFFER_SIZE 2048

// ===== Camera Initialization =====
bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA;
  config.jpeg_quality = 12;
  config.fb_count = 2;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x", err);
    config.frame_size = FRAMESIZE_QVGA;
    config.jpeg_quality = 15;
    config.fb_count = 1;
    err = esp_camera_init(&config);
    if (err != ESP_OK) {
      Serial.printf("Camera init fallback also failed: 0x%x", err);
      return false;
    }
  }

  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    s->set_framesize(s, FRAMESIZE_VGA);
    s->set_quality(s, 12);
    s->set_brightness(s, 0);
    s->set_contrast(s, 0);
    s->set_saturation(s, 0);
    s->set_special_effect(s, 0);
    s->set_whitebal(s, 1);
    s->set_awb_gain(s, 1);
    s->set_wb_mode(s, 0);
    s->set_exposure_ctrl(s, 1);
    s->set_aec2(s, 0);
    s->set_ae_level(s, 0);
    s->set_aec_value(s, 300);
    s->set_gain_ctrl(s, 1);
    s->set_agc_gain(s, 0);
    s->set_gainceiling(s, (gainceiling_t)0);
    s->set_bpc(s, 0);
    s->set_wpc(s, 1);
    s->set_raw_gma(s, 1);
    s->set_lenc(s, 1);
    s->set_hmirror(s, 0);
    s->set_vflip(s, 0);
    s->set_dcw(s, 1);
    s->set_colorbar(s, 0);
  }
  return true;
}

// ===== HTTP Helpers =====

String getRequestUrl(const String& request) {
  int s = request.indexOf(' ');
  if (s < 0) return "";
  int e = request.indexOf(' ', s + 1);
  if (e < 0) return "";
  return request.substring(s + 1, e);
}

String getQueryParam(const String& url, const String& param) {
  int p = url.indexOf('?');
  if (p < 0) return "";
  String qs = url.substring(p + 1);
  int idx = qs.indexOf(param + "=");
  if (idx < 0) return "";
  int vs = idx + param.length() + 1;
  int ve = qs.indexOf('&', vs);
  if (ve < 0) ve = qs.length();
  return qs.substring(vs, ve);
}

void sendResponse(WiFiClient& c, int code, const char* ct, const String& body) {
  c.printf("HTTP/1.1 %d %s\r\n", code,
    code == 200 ? "OK" : code == 400 ? "Bad Request" : code == 404 ? "Not Found" : "Internal Server Error");
  c.printf("Content-Type: %s\r\n", ct);
  c.printf("Content-Length: %d\r\n", body.length());
  c.print("Connection: close\r\n\r\n");
  c.print(body);
  c.flush();
  c.stop();
}

void sendJSON(WiFiClient& c, int code, const String& json) { sendResponse(c, code, "application/json", json); }
void sendPlain(WiFiClient& c, int code, const String& text) { sendResponse(c, code, "text/plain", text); }

// ===== Route Handlers =====

void handleRoot(WiFiClient& c) {
  String ip = WiFi.localIP().toString();
  String html = String("") +
    "<!DOCTYPE html><html><head><title>ESP32-CAM</title>"
    "<style>body{background:#111;color:#eee;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;padding:40px}"
    "h1{color:#3b82f6}img{max-width:100%;border-radius:8px;border:2px solid #333}"
    "a{color:#3b82f6;text-decoration:none;padding:8px 16px;background:#1a2235;border-radius:6px;margin:4px}"
    "a:hover{background:#243044}</style></head><body>"
    "<h1>ESP32-CAM Watchtower</h1>"
    "<p>IP: " + ip + "</p>"
    "<div style='display:flex;gap:8px;margin:16px 0'>"
    "<a href='/stream'>Live Stream</a>"
    "<a href='/capture'>Snapshot</a>"
    "<a href='/status'>Status</a>"
    "</div>"
    "<img src='/capture' style='max-width:640px'>"
    "</body></html>";
  sendResponse(c, 200, "text/html", html);
}

void handleCapture(WiFiClient& c) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { sendPlain(c, 500, "Camera capture failed"); return; }

  c.print("HTTP/1.1 200 OK\r\n");
  c.print("Content-Type: image/jpeg\r\n");
  c.printf("Content-Length: %d\r\n", fb->len);
  c.print("Cache-Control: no-cache, no-store, must-revalidate\r\n");
  c.print("Pragma: no-cache\r\nExpires: 0\r\nConnection: close\r\n\r\n");
  c.write((const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  c.flush();
  c.stop();
}

void handleStream(WiFiClient& c) {
  for (int i = 0; i < MAX_STREAM_CLIENTS; i++) {
    if (!streamClients[i] || !streamClients[i].connected()) {
      if (streamClients[i]) streamClients[i].stop();

      c.printf("HTTP/1.1 200 OK\r\nContent-Type: %s\r\n", STREAM_CONTENT_TYPE);
      c.print("Cache-Control: no-cache, no-store, must-revalidate\r\n");
      c.print("Pragma: no-cache\r\nExpires: 0\r\nConnection: close\r\n\r\n");
      c.flush();
      streamClients[i] = c;
      return;
    }
  }
  sendPlain(c, 503, "Too many stream clients");
}

void handleSignal(WiFiClient& c) {
  int rssi = WiFi.RSSI();
  String json = "{\"rssi\":" + String(rssi) + ",\"signal\":\"";
  json += (rssi > -50 ? "excellent" : rssi > -70 ? "good" : rssi > -85 ? "fair" : "poor");
  json += "\"}";
  sendJSON(c, 200, json);
}

void handleStatus(WiFiClient& c) {
  sensor_t* s = esp_camera_sensor_get();
  if (!s) { sendJSON(c, 500, "{\"error\":\"Sensor not found\"}"); return; }
  static const char* resNames[] = {"96x96","qqvga","qcif","hqvga","qvga","cif","vga","svga","xga","hd","sxga","uxga","fhd","qxga","qhdc","wuxga","ofisr","oful"};
  const char* res = (s->status.framesize >= 0 && s->status.framesize < 18) ? resNames[s->status.framesize] : "unknown";
  char buf[512];
  snprintf(buf, sizeof(buf),
    "{\"resolution\":\"%s\",\"quality\":%d,\"hmirror\":%d,\"vflip\":%d,"
    "\"brightness\":%d,\"contrast\":%d,\"flash_on\":%s}",
    res, s->status.quality, s->status.hmirror, s->status.vflip,
    s->status.brightness, s->status.contrast,
    #ifdef LED_FLASH
    flashState ? "true" : "false"
    #else
    "false"
    #endif
  );
  sendJSON(c, 200, buf);
}

void handleSetResolution(WiFiClient& c, const String& url) {
  String res = getQueryParam(url, "res");
  if (res.isEmpty()) { sendPlain(c, 400, "Missing 'res' parameter"); return; }
  sensor_t* s = esp_camera_sensor_get();
  if (!s) { sendPlain(c, 500, "Sensor not found"); return; }
  framesize_t fs;
  if (res == "qvga")      fs = FRAMESIZE_QVGA;
  else if (res == "vga")  fs = FRAMESIZE_VGA;
  else if (res == "svga") fs = FRAMESIZE_SVGA;
  else if (res == "hd")   fs = FRAMESIZE_HD;
  else if (res == "sxga") fs = FRAMESIZE_SXGA;
  else if (res == "uxga") fs = FRAMESIZE_UXGA;
  else { sendPlain(c, 400, "Invalid resolution"); return; }
  s->set_framesize(s, fs);
  sendPlain(c, 200, "Resolution set to " + res);
}

void handleSetQuality(WiFiClient& c, const String& url) {
  String qs = getQueryParam(url, "q");
  if (qs.isEmpty()) { sendPlain(c, 400, "Missing 'q' parameter"); return; }
  int q = constrain(qs.toInt(), 4, 63);
  sensor_t* s = esp_camera_sensor_get();
  if (!s) { sendPlain(c, 500, "Sensor not found"); return; }
  s->set_quality(s, q);
  sendPlain(c, 200, "Quality set to " + String(q));
}

void handleSetMirror(WiFiClient& c, const String& url) {
  String hs = getQueryParam(url, "h");
  if (hs.isEmpty()) { sendPlain(c, 400, "Missing 'h' parameter"); return; }
  sensor_t* s = esp_camera_sensor_get();
  if (!s) { sendPlain(c, 500, "Sensor not found"); return; }
  s->set_hmirror(s, hs.toInt() ? 1 : 0);
  sendPlain(c, 200, hs.toInt() ? "Mirror enabled" : "Mirror disabled");
}

void handleSetFlip(WiFiClient& c, const String& url) {
  String vs = getQueryParam(url, "v");
  if (vs.isEmpty()) { sendPlain(c, 400, "Missing 'v' parameter"); return; }
  sensor_t* s = esp_camera_sensor_get();
  if (!s) { sendPlain(c, 500, "Sensor not found"); return; }
  s->set_vflip(s, vs.toInt() ? 1 : 0);
  sendPlain(c, 200, vs.toInt() ? "Flip enabled" : "Flip disabled");
}

void handleSetFlash(WiFiClient& c, const String& url) {
  #ifdef LED_FLASH
  String es = getQueryParam(url, "en");
  if (es.isEmpty()) { sendPlain(c, 400, "Missing 'en' parameter"); return; }
  pinMode(LED_FLASH, OUTPUT);
  if (es.toInt()) {
    flashState = true; flashStartTime = millis(); digitalWrite(LED_FLASH, HIGH);
    sendPlain(c, 200, "Flash ON -> auto-shutdown in 30s");
  } else {
    flashState = false; digitalWrite(LED_FLASH, LOW);
    sendPlain(c, 200, "Flash OFF");
  }
  #else
  sendJSON(c, 400,
    "{\"error\":\"Flash pin not defined. Uncomment #define LED_FLASH 4 in the ESP32 sketch and verify your board's GPIO.\"}"
  );
  #endif
}

void handleSetBrightness(WiFiClient& c, const String& url) {
  String vs = getQueryParam(url, "val");
  if (vs.isEmpty()) { sendPlain(c, 400, "Missing 'val' parameter"); return; }
  sensor_t* s = esp_camera_sensor_get();
  if (!s) { sendPlain(c, 500, "Sensor not found"); return; }
  s->set_brightness(s, constrain(vs.toInt(), -2, 2));
  sendPlain(c, 200, "Brightness set to " + vs);
}

void handleSetContrast(WiFiClient& c, const String& url) {
  String vs = getQueryParam(url, "val");
  if (vs.isEmpty()) { sendPlain(c, 400, "Missing 'val' parameter"); return; }
  sensor_t* s = esp_camera_sensor_get();
  if (!s) { sendPlain(c, 500, "Sensor not found"); return; }
  s->set_contrast(s, constrain(vs.toInt(), -2, 2));
  sendPlain(c, 200, "Contrast set to " + vs);
}

void routeRequest(WiFiClient& c, const String& url) {
  if (url == "/" || url.isEmpty())                               handleRoot(c);
  else if (url.startsWith("/stream"))                            handleStream(c);
  else if (url.startsWith("/capture"))                           handleCapture(c);
  else if (url.startsWith("/signal"))                            handleSignal(c);
  else if (url.startsWith("/status"))                            handleStatus(c);
  else if (url.startsWith("/resolution"))                        handleSetResolution(c, url);
  else if (url.startsWith("/quality"))                           handleSetQuality(c, url);
  else if (url.startsWith("/mirror"))                            handleSetMirror(c, url);
  else if (url.startsWith("/flip"))                              handleSetFlip(c, url);
  else if (url.startsWith("/flash"))                             handleSetFlash(c, url);
  else if (url.startsWith("/brightness"))                        handleSetBrightness(c, url);
  else if (url.startsWith("/contrast"))                          handleSetContrast(c, url);
  else                                                           sendPlain(c, 404, "Not Found");
}

// ===== Setup =====
void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println("\n\n=== ESP32-CAM Watchtower Streamer ===");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500); Serial.print(".");
    if (millis() - start > 15000) { Serial.println("\nWiFi timeout -> rebooting"); ESP.restart(); }
  }
  Serial.println("\nWiFi connected! IP: " + WiFi.localIP().toString());

  if (!initCamera()) { Serial.println("Camera init failed -> rebooting"); delay(3000); ESP.restart(); }
  Serial.println("Camera initialized");

  server.begin();
  Serial.println("Server started on port " + String(SERVER_PORT));
  Serial.println("Stream:  http://" + WiFi.localIP().toString() + ":" + String(SERVER_PORT) + "/stream");
  Serial.println("Capture: http://" + WiFi.localIP().toString() + ":" + String(SERVER_PORT) + "/capture");
  Serial.println("========================================");
}

// ===== Main Loop =====
void loop() {
  // --- Accept new connections ---
  WiFiClient client = server.available();
  if (client) {
    String request;
    unsigned long timeout = millis() + 2000;
    while (client.connected() && !client.available()) {
      if (millis() > timeout) break;
      delay(1);
    }
    while (client.available()) {
      char c = client.read();
      request += c;
      if (request.endsWith("\r\n\r\n") || request.length() >= REQUEST_BUFFER_SIZE) break;
    }
    if (request.length() > 0) {
      String url = getRequestUrl(request);
      routeRequest(client, url);
    } else {
      client.stop();
    }
  }

  // --- Stream frames to active MJPEG clients ---
  unsigned long now = millis();
  if (now - lastFrameTime >= FRAME_INTERVAL) {
    lastFrameTime = now;

    bool anyActive = false;
    for (int i = 0; i < MAX_STREAM_CLIENTS; i++) {
      if (streamClients[i] && streamClients[i].connected()) { anyActive = true; break; }
      if (streamClients[i]) { streamClients[i].stop(); streamClients[i] = WiFiClient(); }
    }

    if (anyActive) {
      camera_fb_t* fb = esp_camera_fb_get();
      if (fb) {
        for (int i = 0; i < MAX_STREAM_CLIENTS; i++) {
          if (streamClients[i] && streamClients[i].connected()) {
            streamClients[i].printf("--%s\r\nContent-Type: image/jpeg\r\n\r\n", STREAM_BOUNDARY);
            streamClients[i].write((const char*)fb->buf, fb->len);
            streamClients[i].print("\r\n");
            streamClients[i].flush();
          }
        }
        esp_camera_fb_return(fb);
      }
    }
  }

  #ifdef LED_FLASH
    if (flashState && millis() - flashStartTime > FLASH_MAX_DURATION) {
      flashState = false; digitalWrite(LED_FLASH, LOW);
    }
  #endif
}
