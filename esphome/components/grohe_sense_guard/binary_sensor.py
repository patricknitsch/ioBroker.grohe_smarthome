import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import binary_sensor
from esphome.const import CONF_ID
from . import grohe_ns, GroheSenseGuard, CONF_GROHE_ID

CONF_VALVE_OPEN     = "valve_open"
CONF_SNOOZE_ACTIVE  = "snooze_active"
CONF_PRESSURE_TEST  = "pressure_test"
CONF_SPRINKLER_MON  = "sprinkler_monday"
CONF_SPRINKLER_TUE  = "sprinkler_tuesday"
CONF_SPRINKLER_WED  = "sprinkler_wednesday"
CONF_SPRINKLER_THU  = "sprinkler_thursday"
CONF_SPRINKLER_FRI  = "sprinkler_friday"
CONF_SPRINKLER_SAT  = "sprinkler_saturday"
CONF_SPRINKLER_SUN  = "sprinkler_sunday"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_GROHE_ID): cv.use_id(GroheSenseGuard),
        cv.Optional(CONF_VALVE_OPEN):    binary_sensor.binary_sensor_schema(),
        cv.Optional(CONF_SNOOZE_ACTIVE): binary_sensor.binary_sensor_schema(),
        cv.Optional(CONF_PRESSURE_TEST): binary_sensor.binary_sensor_schema(),
        cv.Optional(CONF_SPRINKLER_MON): binary_sensor.binary_sensor_schema(),
        cv.Optional(CONF_SPRINKLER_TUE): binary_sensor.binary_sensor_schema(),
        cv.Optional(CONF_SPRINKLER_WED): binary_sensor.binary_sensor_schema(),
        cv.Optional(CONF_SPRINKLER_THU): binary_sensor.binary_sensor_schema(),
        cv.Optional(CONF_SPRINKLER_FRI): binary_sensor.binary_sensor_schema(),
        cv.Optional(CONF_SPRINKLER_SAT): binary_sensor.binary_sensor_schema(),
        cv.Optional(CONF_SPRINKLER_SUN): binary_sensor.binary_sensor_schema(),
    }
)

_SETTERS = {
    CONF_VALVE_OPEN:    "set_valve_open",
    CONF_SNOOZE_ACTIVE: "set_snooze_active",
    CONF_PRESSURE_TEST: "set_pressure_test",
    CONF_SPRINKLER_MON: "set_sprinkler_monday",
    CONF_SPRINKLER_TUE: "set_sprinkler_tuesday",
    CONF_SPRINKLER_WED: "set_sprinkler_wednesday",
    CONF_SPRINKLER_THU: "set_sprinkler_thursday",
    CONF_SPRINKLER_FRI: "set_sprinkler_friday",
    CONF_SPRINKLER_SAT: "set_sprinkler_saturday",
    CONF_SPRINKLER_SUN: "set_sprinkler_sunday",
}


async def to_code(config):
    hub = await cg.get_variable(config[CONF_GROHE_ID])
    for conf_key, setter in _SETTERS.items():
        if conf_key in config:
            sens = await binary_sensor.new_binary_sensor(config[conf_key])
            cg.add(getattr(hub, setter)(sens))
