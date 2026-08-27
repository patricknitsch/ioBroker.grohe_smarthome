import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import uart
from esphome.const import CONF_ID

DEPENDENCIES = ["uart"]
AUTO_LOAD = ["sensor", "binary_sensor", "switch", "number", "text_sensor"]

grohe_ns = cg.esphome_ns.namespace("grohe_sense_guard")
GroheSenseGuard = grohe_ns.class_(
    "GroheSenseGuard", cg.PollingComponent, uart.UARTDevice
)

CONF_GROHE_ID = "grohe_id"

CONFIG_SCHEMA = (
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(GroheSenseGuard),
        }
    )
    .extend(uart.UART_DEVICE_SCHEMA)
    .extend(cv.polling_component_schema("30s"))
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await uart.register_uart_device(var, config)
