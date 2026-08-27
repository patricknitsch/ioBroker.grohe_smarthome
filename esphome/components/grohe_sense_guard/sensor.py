import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import sensor
from esphome.const import (
    CONF_ID,
    UNIT_MINUTE,
    ICON_TIMER,
)
from . import grohe_ns, GroheSenseGuard, CONF_GROHE_ID

CONF_SPRINKLER_START = "sprinkler_start_time"
CONF_SPRINKLER_STOP  = "sprinkler_stop_time"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_GROHE_ID): cv.use_id(GroheSenseGuard),
        cv.Optional(CONF_SPRINKLER_START): sensor.sensor_schema(
            unit_of_measurement=UNIT_MINUTE,
            icon=ICON_TIMER,
            accuracy_decimals=0,
        ),
        cv.Optional(CONF_SPRINKLER_STOP): sensor.sensor_schema(
            unit_of_measurement=UNIT_MINUTE,
            icon=ICON_TIMER,
            accuracy_decimals=0,
        ),
    }
)


async def to_code(config):
    hub = await cg.get_variable(config[CONF_GROHE_ID])
    if CONF_SPRINKLER_START in config:
        sens = await sensor.new_sensor(config[CONF_SPRINKLER_START])
        cg.add(hub.set_sprinkler_start(sens))
    if CONF_SPRINKLER_STOP in config:
        sens = await sensor.new_sensor(config[CONF_SPRINKLER_STOP])
        cg.add(hub.set_sprinkler_stop(sens))
