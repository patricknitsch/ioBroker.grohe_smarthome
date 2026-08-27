#pragma once

#include "esphome/core/component.h"
#include "esphome/core/log.h"
#include "esphome/components/uart/uart.h"
#include "esphome/components/sensor/sensor.h"
#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/text_sensor/text_sensor.h"
#include "grohe_protocol.h"
#include <vector>

namespace esphome {
namespace grohe_sense_guard {

static const char *const TAG = "grohe";

class GroheSenseGuard : public PollingComponent, public uart::UARTDevice {
 public:
  // ── Sensor setters (called from sensor.py / binary_sensor.py) ────────────
  void set_valve_open(binary_sensor::BinarySensor *s)   { valve_open_ = s; }
  void set_snooze_active(binary_sensor::BinarySensor *s) { snooze_active_ = s; }
  void set_pressure_test(binary_sensor::BinarySensor *s) { pressure_test_ = s; }

  void set_sprinkler_monday(binary_sensor::BinarySensor *s)    { sprinkler_days_[0] = s; }
  void set_sprinkler_tuesday(binary_sensor::BinarySensor *s)   { sprinkler_days_[1] = s; }
  void set_sprinkler_wednesday(binary_sensor::BinarySensor *s) { sprinkler_days_[2] = s; }
  void set_sprinkler_thursday(binary_sensor::BinarySensor *s)  { sprinkler_days_[3] = s; }
  void set_sprinkler_friday(binary_sensor::BinarySensor *s)    { sprinkler_days_[4] = s; }
  void set_sprinkler_saturday(binary_sensor::BinarySensor *s)  { sprinkler_days_[5] = s; }
  void set_sprinkler_sunday(binary_sensor::BinarySensor *s)    { sprinkler_days_[6] = s; }

  void set_sprinkler_start(sensor::Sensor *s) { sprinkler_start_ = s; }
  void set_sprinkler_stop(sensor::Sensor *s)  { sprinkler_stop_ = s; }
  void set_firmware_version(text_sensor::TextSensor *s) { firmware_version_ = s; }

  // Raw frame capture – every received frame as hex string
  void set_last_raw_frame(text_sensor::TextSensor *s)     { last_raw_frame_ = s; }
  // Unknown frame types only
  void set_last_unknown_frame(text_sensor::TextSensor *s) { last_unknown_frame_ = s; }

  // Callback: fires for every successfully parsed frame (type, flags, hex payload)
  // Register from YAML via on_frame automation trigger (future).
  void add_on_frame_callback(std::function<void(uint8_t, uint8_t, std::string)> cb) {
    on_frame_callbacks_.push_back(std::move(cb));
  }

  // ── ESPHome lifecycle ────────────────────────────────────────────────────
  void setup() override;
  void loop() override;
  float get_setup_priority() const override { return setup_priority::DATA; }
  void update() override;

  // ── Command API ──────────────────────────────────────────────────────────
  void valve_open();
  void valve_close();
  void snooze_start(uint16_t duration_minutes);
  void snooze_stop();
  void set_sprinkler(uint16_t start_min, uint16_t stop_min, bool days[7]);
  void sprinkler_off();
  void request_status();

 protected:
  // ── Receive buffer ───────────────────────────────────────────────────────
  std::vector<uint8_t> rx_buf_;
  bool in_frame_{false};
  uint32_t last_byte_ms_{0};

  // ── Last known device address ────────────────────────────────────────────
  uint8_t dev_addr_[6]{0x99, 0x99, 0x99, 0x99, 0x99, 0x99};
  uint8_t tx_seq_{0x01}; // outgoing sequence counter (start at 1, matching observed app frames)
  uint8_t poll_counter_{0x01}; // type=0x03 counter byte, mirrors MCU behaviour

  // ── Last known config/status payloads (used for partial writes) ─────────
  std::vector<uint8_t> last_config_payload_;
  std::vector<uint8_t> last_status_payload_;

  // ── Sensors ─────────────────────────────────────────────────────────────
  binary_sensor::BinarySensor *valve_open_{nullptr};
  binary_sensor::BinarySensor *snooze_active_{nullptr};
  binary_sensor::BinarySensor *pressure_test_{nullptr};
  binary_sensor::BinarySensor *sprinkler_days_[7]{};
  sensor::Sensor *sprinkler_start_{nullptr};
  sensor::Sensor *sprinkler_stop_{nullptr};
  text_sensor::TextSensor *firmware_version_{nullptr};
  text_sensor::TextSensor *last_raw_frame_{nullptr};
  text_sensor::TextSensor *last_unknown_frame_{nullptr};

  std::vector<std::function<void(uint8_t, uint8_t, std::string)>> on_frame_callbacks_;

  // ── Internal helpers ─────────────────────────────────────────────────────
  void process_byte_(uint8_t byte);
  void process_frame_();
  void handle_info_(const GroheFrame &f);
  void handle_water_data_(const GroheFrame &f);
  void handle_status_(const GroheFrame &f);
  void handle_config_(const GroheFrame &f);
  bool build_status_cmd_(std::vector<uint8_t> &payload, int valve, int snooze,
                          uint16_t snooze_min = 0);
  void send_frame_(const std::vector<uint8_t> &frame);
  void verify_checksum_(const std::vector<uint8_t> &raw);
  uint8_t next_seq_() { return tx_seq_++; }

  // Convert a byte vector to a hex string like "FE FE 68 ..."
  static std::string to_hex_(const std::vector<uint8_t> &data);
  // Publish frame to raw sensors and fire callbacks
  void publish_raw_frame_(const GroheFrame &f, const std::vector<uint8_t> &raw);
};

}  // namespace grohe_sense_guard
}  // namespace esphome
