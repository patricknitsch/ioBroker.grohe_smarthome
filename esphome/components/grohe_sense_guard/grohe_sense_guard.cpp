#include "grohe_sense_guard.h"
#include "esphome/core/hal.h"

namespace esphome {
namespace grohe_sense_guard {

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Loop
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::setup() {
  ESP_LOGI(TAG, "Grohe Sense Guard component ready");
}

void GroheSenseGuard::update() {
  // Periodic keep-alive: only log that we are alive; the MCU drives heartbeat timing.
  // Real polling happens in handle_water_data_ (we echo back MCU type=0x03 frames).
  ESP_LOGD(TAG, "Alive (waiting for MCU heartbeat)");
}

void GroheSenseGuard::request_status() {
  ESP_LOGI(TAG, "CMD: request status");
  // Send a minimal STATUS read request to ask MCU for current state.
  uint8_t seq = next_seq_();
  std::vector<uint8_t> data(7, 0x00);
  data[2] = seq;
  send_frame_(build_frame(dev_addr_, MSG_STATUS, FLAG_READ, seq, data));
}

void GroheSenseGuard::loop() {
  const uint32_t now = millis();

  // Flush incomplete frame if no byte received for 50 ms
  if (in_frame_ && (now - last_byte_ms_ > 50)) {
    ESP_LOGW(TAG, "Frame timeout, flushing %u bytes", (unsigned)rx_buf_.size());
    rx_buf_.clear();
    in_frame_ = false;
  }

  while (available()) {
    uint8_t byte;
    read_byte(&byte);
    process_byte_(byte);
    last_byte_ms_ = now;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Byte-level receive state machine
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::process_byte_(uint8_t byte) {
  // Ignore wake bytes outside a frame
  if (!in_frame_ && byte == GROHE_WAKE_BYTE) return;

  if (!in_frame_) {
    if (byte == GROHE_START_BYTE) {
      rx_buf_.clear();
      rx_buf_.push_back(byte);
      in_frame_ = true;
    }
    return;
  }

  rx_buf_.push_back(byte);

  // Minimum frame: 68 [6addr] 68 ctrl len 00 00 len 0C 61 type flags 00 00 seq CS 16
  // = 1+6+1+1+1+2+1+1+1+1+1+1+1+2+1+1 = 22 bytes minimum
  if (byte == GROHE_STOP_BYTE && rx_buf_.size() >= 22) {
    process_frame_();
    rx_buf_.clear();
    in_frame_ = false;
  }

  // Safety: discard if buffer too large (max frame ~200 bytes)
  if (rx_buf_.size() > 200) {
    ESP_LOGW(TAG, "Frame buffer overflow, discarding");
    rx_buf_.clear();
    in_frame_ = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame parser dispatcher
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::process_frame_() {
  GroheFrame frame;
  if (!parse_frame(rx_buf_, frame)) {
    ESP_LOGD(TAG, "Failed to parse frame (%u bytes)", (unsigned)rx_buf_.size());
    return;
  }

  // Remember device address for sending commands back
  memcpy(dev_addr_, frame.addr, 6);

  ESP_LOGD(TAG, "Frame: type=0x%02X flags=0x%02X seq=%u payload=%u bytes",
           frame.msg_type, frame.flags, frame.seq, (unsigned)frame.payload.size());

  // Publish to raw sensors + fire callbacks for every frame
  publish_raw_frame_(frame, rx_buf_);
  verify_checksum_(rx_buf_);

  switch (frame.msg_type) {
    case MSG_INFO:      handle_info_(frame);    break;
    case MSG_STATUS:    handle_status_(frame);  break;
    case MSG_CONFIG:
    case MSG_CONFIG_RESP: handle_config_(frame); break;
    case MSG_HEARTBEAT:
      ESP_LOGD(TAG, "Heartbeat seq=%u", frame.seq);
      break;
    case MSG_WATER_DATA:
      handle_water_data_(frame);
      break;
    default:
      ESP_LOGW(TAG, "UNKNOWN type=0x%02X flags=0x%02X seq=%u payload: %s",
               frame.msg_type, frame.flags, frame.seq,
               to_hex_(frame.payload).c_str());
      if (last_unknown_frame_)
        last_unknown_frame_->publish_state(to_hex_(rx_buf_));
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Info packet (firmware version, device serial)
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::handle_info_(const GroheFrame &f) {
  // ASCII identifier starts at payload[13] (after fixed header fields)
  // "^1Z16010C186E000200040004" = firmware/serial string
  if (firmware_version_ && f.payload.size() >= 14) {
    std::string ver;
    for (size_t i = 13; i < f.payload.size(); i++) {
      uint8_t b = f.payload[i];
      if (b == 0x00) break;
      if (b >= 0x20 && b < 0x7F) ver += static_cast<char>(b);
    }
    if (!ver.empty()) {
      ESP_LOGI(TAG, "Firmware/ID: %s", ver.c_str());
      firmware_version_->publish_state(ver);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status packet (valve, snooze, pressure test)
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::handle_water_data_(const GroheFrame &f) {
  // Periodic MCU heartbeat (type=0x03). Counter byte increments each frame.
  // The ESP8266 likely responds to these to keep the session alive.
  // We mirror the same frame back so the MCU sees an active controller.
  const auto &p = f.payload;
  uint8_t counter = p.empty() ? 0x01 : p.back();
  ESP_LOGD(TAG, "WaterData heartbeat counter=0x%02X – echoing back", counter);

  // Echo: same payload format the MCU sent, counter unchanged
  std::vector<uint8_t> reply(p.size(), 0x00);
  if (!reply.empty()) reply.back() = counter;
  send_frame_(build_frame(dev_addr_, MSG_WATER_DATA, FLAG_READ, 0, reply));
}

void GroheSenseGuard::handle_status_(const GroheFrame &f) {
  const auto &p = f.payload;

  // flags bit 0 (0x01) = short ACK frame (7 bytes), sent by MCU to confirm receipt of a command.
  if (f.flags & 0x01) {
    ESP_LOGD(TAG, "ACK: seq=%u flags=0x%02X", f.seq, f.flags);
    return;
  }

  if (p.size() <= STATUS_SNOOZE) {
    ESP_LOGW(TAG, "Status packet too short: %u", (unsigned)p.size());
    return;
  }

  // Cache for use as write template (mirrors CONFIG cache pattern)
  last_status_payload_ = p;

  bool ptest  = (p[STATUS_PRESSURE_TEST] == 0x08);
  bool vopen  = (p[STATUS_VALVE_STATE]   == 0x01);
  // Snooze is encoded in both flags bit 1 (0x02) and payload[STATUS_SNOOZE].
  // Use flags as primary since it appears in every status frame.
  bool snooze = (f.flags & 0x02) || (p[STATUS_SNOOZE] == 0x01);

  ESP_LOGI(TAG, "Status: valve=%s snooze=%s pressure_test=%s flags=0x%02X",
           vopen ? "OPEN" : "CLOSED",
           snooze ? "ON" : "OFF",
           ptest ? "RUNNING" : "idle",
           f.flags);

  if (valve_open_)    valve_open_->publish_state(vopen);
  if (snooze_active_) snooze_active_->publish_state(snooze);
  if (pressure_test_) pressure_test_->publish_state(ptest);
}

// ─────────────────────────────────────────────────────────────────────────────
// Config packet (sprinkler times and days)
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::handle_config_(const GroheFrame &f) {
  const auto &p = f.payload;

  if (p.size() <= CFG_SPRINKLER_SUN) {
    ESP_LOGW(TAG, "Config packet too short: %u", (unsigned)p.size());
    return;
  }

  // Cache config for later partial writes (e.g. only change sprinkler days)
  last_config_payload_ = p;

  // Sprinkler times are stored big-endian (high byte first) in the CONFIG payload.
  uint16_t start_min = (static_cast<uint16_t>(p[CFG_SPRINKLER_START]) << 8)
                      | p[CFG_SPRINKLER_START + 1];
  uint16_t stop_min  = (static_cast<uint16_t>(p[CFG_SPRINKLER_STOP]) << 8)
                      | p[CFG_SPRINKLER_STOP + 1];

  ESP_LOGI(TAG, "Config: sprinkler %02u:%02u – %02u:%02u  days=",
           start_min / 60, start_min % 60,
           stop_min  / 60, stop_min  % 60);

  static const char *day_names[] = {"Mon","Tue","Wed","Thu","Fri","Sat","Sun"};
  for (int d = 0; d < 7; d++) {
    bool active = (p[CFG_SPRINKLER_MON + d] == 0x01);
    ESP_LOGI(TAG, "  %s: %s", day_names[d], active ? "ON" : "off");
    if (sprinkler_days_[d]) sprinkler_days_[d]->publish_state(active);
  }

  if (sprinkler_start_) sprinkler_start_->publish_state(start_min);
  if (sprinkler_stop_)  sprinkler_stop_->publish_state(stop_min);
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: Valve open
// ─────────────────────────────────────────────────────────────────────────────

// Build a write-STATUS payload from the last received STATUS, changing only
// the requested fields. Returns false if no STATUS has been cached yet.
bool GroheSenseGuard::build_status_cmd_(std::vector<uint8_t> &payload,
                                         int valve,   // -1=keep, 0=close, 1=open
                                         int snooze,  // -1=keep, 0=off, 1=on
                                         uint16_t snooze_min) {
  if (last_status_payload_.size() <= STATUS_SNOOZE) {
    // No STATUS received yet — use safe default matching observed app format.
    // 16 bytes: 00 00 [seq] 00 00 00 07 [valve=0] 00 00 00 00 [snooze=0] 00 00 02
    ESP_LOGD(TAG, "No STATUS cached, using default template");
    last_status_payload_.assign(16, 0x00);
    last_status_payload_[6]  = 0x07;
    last_status_payload_[12] = 0x01; // app always sets this byte; required for MCU to execute
    last_status_payload_[15] = 0x02;
  }
  payload = last_status_payload_;
  payload[PAY_SEQ] = next_seq_();
  // App write commands always use payload[5]=0x00, payload[6]=0x07.
  // The MCU uses [5]=0x01, [6]=0x00 in broadcasts — override for commands.
  payload[5] = 0x00;
  payload[6] = 0x07;
  if (valve  >= 0) payload[STATUS_VALVE_STATE] = valve  ? 0x01 : 0x00;
  if (snooze >= 0) {
    payload[STATUS_SNOOZE] = snooze ? 0x01 : 0x00;
    if (snooze && last_status_payload_.size() > STATUS_SNOOZE + 2) {
      payload[STATUS_SNOOZE + 1] = static_cast<uint8_t>(snooze_min & 0xFF);
      payload[STATUS_SNOOZE + 2] = static_cast<uint8_t>(snooze_min >> 8);
    }
  }
  return true;
}

void GroheSenseGuard::valve_open() {
  ESP_LOGI(TAG, "CMD: valve open");
  std::vector<uint8_t> data;
  if (!build_status_cmd_(data, 1, -1)) return;
  send_frame_(build_frame(dev_addr_, MSG_STATUS, FLAG_WRITE, data[PAY_SEQ], data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: Valve close
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::valve_close() {
  ESP_LOGI(TAG, "CMD: valve close");
  std::vector<uint8_t> data;
  if (!build_status_cmd_(data, 0, -1)) return;
  send_frame_(build_frame(dev_addr_, MSG_STATUS, FLAG_WRITE, data[PAY_SEQ], data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: Snooze start
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::snooze_start(uint16_t duration_minutes) {
  ESP_LOGI(TAG, "CMD: snooze start %u min", duration_minutes);
  std::vector<uint8_t> data;
  if (!build_status_cmd_(data, -1, 1, duration_minutes)) return;
  send_frame_(build_frame(dev_addr_, MSG_STATUS, FLAG_WRITE, data[PAY_SEQ], data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: Snooze stop
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::snooze_stop() {
  ESP_LOGI(TAG, "CMD: snooze stop");
  std::vector<uint8_t> data;
  if (!build_status_cmd_(data, -1, 0)) return;
  send_frame_(build_frame(dev_addr_, MSG_STATUS, FLAG_WRITE, data[PAY_SEQ], data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: Sprinkler configure
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::set_sprinkler(uint16_t start_min, uint16_t stop_min, bool days[7]) {
  if (last_config_payload_.size() <= CFG_SPRINKLER_SUN) {
    ESP_LOGW(TAG, "Config not received yet (size=%u, need>%u) – trigger a config read first",
             (unsigned)last_config_payload_.size(), (unsigned)CFG_SPRINKLER_SUN);
    return;
  }

  // Modify a copy of the last known config
  std::vector<uint8_t> payload = last_config_payload_;
  payload[PAY_SEQ] = next_seq_();
  payload[5] = 0x00;
  payload[6] = 0x07; // app write commands always set this byte
  payload[CFG_SPRINKLER_START]     = start_min >> 8;      // big-endian
  payload[CFG_SPRINKLER_START + 1] = start_min & 0xFF;
  payload[CFG_SPRINKLER_STOP]      = stop_min >> 8;
  payload[CFG_SPRINKLER_STOP + 1]  = stop_min & 0xFF;
  for (int d = 0; d < 7; d++)
    payload[CFG_SPRINKLER_MON + d] = days[d] ? 0x01 : 0x00;

  ESP_LOGI(TAG, "CMD: sprinkler %02u:%02u – %02u:%02u",
           start_min / 60, start_min % 60,
           stop_min  / 60, stop_min  % 60);

  send_frame_(build_frame(dev_addr_, MSG_CONFIG, FLAG_WRITE, payload[PAY_SEQ], payload));
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: Sprinkler off (all days disabled)
// ─────────────────────────────────────────────────────────────────────────────

void GroheSenseGuard::sprinkler_off() {
  bool days[7] = {false, false, false, false, false, false, false};
  set_sprinkler(0, 0, days);
}

// ─────────────────────────────────────────────────────────────────────────────
// Send a raw frame via UART
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Hex helper + raw frame publisher
// ─────────────────────────────────────────────────────────────────────────────

std::string GroheSenseGuard::to_hex_(const std::vector<uint8_t> &data) {
  std::string out;
  out.reserve(data.size() * 3);
  char buf[4];
  for (size_t i = 0; i < data.size(); i++) {
    snprintf(buf, sizeof(buf), i ? " %02X" : "%02X", data[i]);
    out += buf;
  }
  return out;
}

void GroheSenseGuard::publish_raw_frame_(const GroheFrame &f,
                                          const std::vector<uint8_t> &raw) {
  // Format: "type=0x04 flags=0x20 seq=11 | FE FE FE FE 68 ..."
  char header[48];
  snprintf(header, sizeof(header), "type=0x%02X flags=0x%02X seq=%u | ",
           f.msg_type, f.flags, f.seq);
  std::string full = std::string(header) + to_hex_(raw);

  ESP_LOGV(TAG, "RAW: %s", full.c_str());

  if (last_raw_frame_)
    last_raw_frame_->publish_state(full);

  // Fire registered callbacks
  for (auto &cb : on_frame_callbacks_)
    cb(f.msg_type, f.flags, to_hex_(raw));
}

void GroheSenseGuard::verify_checksum_(const std::vector<uint8_t> &raw) {
  // raw ends with [CS] [0x16]. Compute CS candidates so we can identify the correct algorithm.
  if (raw.size() < 4) return;
  uint8_t actual_cs = raw[raw.size() - 2];

  // Find position of first 0x68
  size_t pos = 0;
  while (pos < raw.size() && raw[pos] != 0x68) pos++;
  if (pos >= raw.size()) return;

  // Candidate A: sum from second 68 (pos+7) to last data byte (raw.size()-3), mod 256
  uint8_t cs_a = 0;
  for (size_t i = pos + 7; i < raw.size() - 2; i++) cs_a += raw[i];

  // Candidate B: sum from ctrl byte (pos+8) to last data byte, mod 256
  uint8_t cs_b = 0;
  for (size_t i = pos + 8; i < raw.size() - 2; i++) cs_b += raw[i];

  // Candidate C: sum from addr start (pos+1) to last data byte, mod 256
  uint8_t cs_c = 0;
  for (size_t i = pos + 1; i < raw.size() - 2; i++) cs_c += raw[i];

  // Candidate D: sum from CI_SUB (pos+13) to last data byte, mod 256
  uint8_t cs_d = 0;
  if (pos + 13 < raw.size() - 2)
    for (size_t i = pos + 13; i < raw.size() - 2; i++) cs_d += raw[i];

  bool ok = (static_cast<uint8_t>(cs_a - 2) == actual_cs);
  if (ok) {
    ESP_LOGV(TAG, "CS 0x%02X OK", actual_cs);
  } else {
    ESP_LOGW(TAG, "CS MISMATCH actual=0x%02X A-2=0x%02X A=0x%02X B=0x%02X C=0x%02X D=0x%02X",
             actual_cs, (uint8_t)(cs_a - 2), cs_a, cs_b, cs_c, cs_d);
  }
}

void GroheSenseGuard::send_frame_(const std::vector<uint8_t> &frame) {
  uint8_t cs = frame.size() >= 2 ? frame[frame.size() - 2] : 0;
  ESP_LOGD(TAG, "TX %u bytes CS=0x%02X", (unsigned)frame.size(), cs);
  for (uint8_t b : frame) write_byte(b);
}

}  // namespace grohe_sense_guard
}  // namespace esphome
