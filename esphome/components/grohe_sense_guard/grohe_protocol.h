#pragma once
#include <vector>
#include <cstdint>

namespace esphome {
namespace grohe_sense_guard {

// Frame constants
static const uint8_t GROHE_WAKE_BYTE   = 0xFE;
static const uint8_t GROHE_START_BYTE  = 0x68;
static const uint8_t GROHE_START2_ACK  = 0x6A;
static const uint8_t GROHE_STOP_BYTE   = 0x16;
static const uint8_t GROHE_CI_SUB      = 0x0C;
static const uint8_t GROHE_CI_APP      = 0x61;
static const uint8_t GROHE_CTRL        = 0x1F;

// Message types
static const uint8_t MSG_INFO          = 0x01;
static const uint8_t MSG_WATER_DATA    = 0x03;
static const uint8_t MSG_CONFIG        = 0x04;
static const uint8_t MSG_STATUS        = 0x05;
static const uint8_t MSG_HEARTBEAT     = 0x06;
static const uint8_t MSG_CONFIG_RESP   = 0x0C;

// Flags
static const uint8_t FLAG_READ         = 0x20;
// Note: 0x20 is used for BOTH reads (MCU broadcasts) and writes (app commands).
// The MCU distinguishes commands from broadcasts via payload[6]=0x07 in write frames.
static const uint8_t FLAG_WRITE        = 0x20;

// Payload offsets (relative to start of payload, after flags byte)
// Payload layout: 00 00 [seq] [data...]
static const uint8_t PAY_SEQ           = 2;  // sequence number

// Status packet (MSG_STATUS) payload offsets
static const uint8_t STATUS_PRESSURE_TEST = 3;  // 0x08 = pressure test running
static const uint8_t STATUS_VALVE_STATE   = 7;  // 0x01 = open, 0x00 = closed
static const uint8_t STATUS_SNOOZE        = 12; // 0x01 = active

// Config packet (MSG_CONFIG) payload offsets
static const uint8_t CFG_TIMESTAMP    = 11; // uint32 LE, Unix timestamp
static const uint8_t CFG_FLOW_LIMIT   = 15; // uint16 LE, l/h * 10
static const uint8_t CFG_PRESS_MAX    = 19; // uint16 LE, mbar
static const uint8_t CFG_TIME_LIMIT   = 23; // uint16 LE, minutes
static const uint8_t CFG_SPRINKLER_START = 73; // uint16 LE, minutes from midnight
static const uint8_t CFG_SPRINKLER_STOP  = 75; // uint16 LE, minutes from midnight
static const uint8_t CFG_SPRINKLER_MON  = 77;
static const uint8_t CFG_SPRINKLER_TUE  = 78;
static const uint8_t CFG_SPRINKLER_WED  = 79;
static const uint8_t CFG_SPRINKLER_THU  = 80;
static const uint8_t CFG_SPRINKLER_FRI  = 81;
static const uint8_t CFG_SPRINKLER_SAT  = 82;
static const uint8_t CFG_SPRINKLER_SUN  = 83;

struct GroheFrame {
  uint8_t  addr[6];
  uint8_t  frame2;       // 0x68 or 0x6A
  uint8_t  length;
  uint8_t  msg_type;
  uint8_t  flags;
  uint8_t  seq;
  std::vector<uint8_t> payload; // full payload incl. 00 00 seq prefix
  bool     valid;
};

// Parse a complete frame from a byte buffer.
// Returns true and fills frame on success.
inline bool parse_frame(const std::vector<uint8_t> &buf, GroheFrame &frame) {
  frame.valid = false;

  // Find first 0x68
  size_t pos = 0;
  while (pos < buf.size() && buf[pos] != GROHE_START_BYTE) pos++;
  if (pos + 14 >= buf.size()) return false;

  // Addr (6 bytes)
  for (int i = 0; i < 6; i++) frame.addr[i] = buf[pos + 1 + i];

  // Second start byte
  frame.frame2 = buf[pos + 7];
  if (frame.frame2 != GROHE_START_BYTE && frame.frame2 != GROHE_START2_ACK)
    return false;

  // ctrl(1F), length, 00, 00, length2, CI_SUB(0C), CI_APP(61), type, flags
  if (buf[pos + 8] != GROHE_CTRL) return false;
  frame.length    = buf[pos + 9];
  // buf[pos+10] buf[pos+11] = 00 00
  // buf[pos+12] = length echo
  if (buf[pos + 13] != GROHE_CI_SUB) return false;
  if (buf[pos + 14] != GROHE_CI_APP) return false;

  frame.msg_type = buf[pos + 15];
  frame.flags    = buf[pos + 16];

  // Payload starts at pos+17, ends before CS and stop byte
  if (buf.back() != GROHE_STOP_BYTE) return false;
  // CS = buf[buf.size()-2], stop = buf[buf.size()-1]
  frame.payload.assign(buf.begin() + pos + 17, buf.end() - 2);

  if (frame.payload.size() > PAY_SEQ)
    frame.seq = frame.payload[PAY_SEQ];

  frame.valid = true;
  return true;
}

// Build a frame to send to MCU.
// data = complete payload including the leading 00 00 seq prefix.
// L = CI_SUB + CI_APP + type + flags + data = 4 + data.size() + 1 = data.size() + 5
// (empirically verified: STATUS 16-byte payload → L=21, CONFIG 85-byte → L=90)
inline std::vector<uint8_t> build_frame(
    const uint8_t *addr,
    uint8_t msg_type,
    uint8_t flags,
    uint8_t /*seq*/,
    const std::vector<uint8_t> &data)
{
  std::vector<uint8_t> frame;

  // Wake preamble
  frame.insert(frame.end(), 4, GROHE_WAKE_BYTE);

  uint8_t length = static_cast<uint8_t>(data.size() + 5);

  frame.push_back(GROHE_START_BYTE);
  for (int i = 0; i < 6; i++) frame.push_back(addr[i]);
  frame.push_back(GROHE_START_BYTE);
  frame.push_back(GROHE_CTRL);
  frame.push_back(length);
  frame.push_back(0x00);
  frame.push_back(0x00);
  frame.push_back(length);
  frame.push_back(GROHE_CI_SUB);
  frame.push_back(GROHE_CI_APP);
  frame.push_back(msg_type);
  frame.push_back(flags);
  // data contains the complete payload (00 00 seq prefix is part of data, not added separately)
  frame.insert(frame.end(), data.begin(), data.end());

  // CS = sum from second 0x68 (frame[11]) to last data byte, minus 2, mod 256.
  uint8_t cs = 0;
  for (size_t i = 11; i < frame.size(); i++) cs += frame[i];
  cs = static_cast<uint8_t>(cs - 2);
  frame.push_back(cs);
  frame.push_back(GROHE_STOP_BYTE);

  return frame;
}

}  // namespace grohe_sense_guard
}  // namespace esphome
