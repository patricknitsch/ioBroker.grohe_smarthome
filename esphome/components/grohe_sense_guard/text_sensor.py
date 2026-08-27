import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import text_sensor
from esphome.const import CONF_ID
from . import grohe_ns, GroheSenseGuard, CONF_GROHE_ID

CONF_FIRMWARE_VERSION   = "firmware_version"
CONF_LAST_RAW_FRAME     = "last_raw_frame"
CONF_LAST_UNKNOWN_FRAME = "last_unknown_frame"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_GROHE_ID): cv.use_id(GroheSenseGuard),
        cv.Optional(CONF_FIRMWARE_VERSION):   text_sensor.text_sensor_schema(),
        cv.Optional(CONF_LAST_RAW_FRAME):     text_sensor.text_sensor_schema(),
        cv.Optional(CONF_LAST_UNKNOWN_FRAME): text_sensor.text_sensor_schema(),
    }
)


async def to_code(config):
    hub = await cg.get_variable(config[CONF_GROHE_ID])
    if CONF_FIRMWARE_VERSION in config:
        sens = await text_sensor.new_text_sensor(config[CONF_FIRMWARE_VERSION])
        cg.add(hub.set_firmware_version(sens))
    if CONF_LAST_RAW_FRAME in config:
        sens = await text_sensor.new_text_sensor(config[CONF_LAST_RAW_FRAME])
        cg.add(hub.set_last_raw_frame(sens))
    if CONF_LAST_UNKNOWN_FRAME in config:
        sens = await text_sensor.new_text_sensor(config[CONF_LAST_UNKNOWN_FRAME])
        cg.add(hub.set_last_unknown_frame(sens))
