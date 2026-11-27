/**
 * Printer factory + plug-in registry for vendor ZRA-approved fiscal devices.
 *
 * Built-in drivers: escpos-tcp, escpos-serial, console, file.
 *
 * Vendor drivers (e.g. a ZRA-certified fiscal printer or an Electronic Signature
 * Device that signs receipts itself) implement FiscalDeviceDriver and register
 * once at start-up:
 *
 *   registerFiscalDeviceDriver({
 *     name: 'acme-fp200',
 *     vendor: 'ACME',
 *     zraApproved: true,
 *     createPrinter: (cfg) => new AcmeFp200Printer(cfg),
 *     createFiscalClient: (cfg) => new AcmeFp200Signer(cfg), // optional, if the device signs
 *   });
 *   const printer = createPrinter({ driver: 'acme-fp200', options: { host: '10.0.0.5' } });
 */
import type { FiscalClient, ReceiptPrinter } from '@fms/shared';
import { EscPosSerialPrinter, type EscPosSerialConfig } from './drivers/serial.js';
import { ConsolePrinter, FilePrinter, type ConsolePrinterConfig, type FilePrinterConfig } from './drivers/simple.js';
import { EscPosTcpPrinter, type EscPosTcpConfig } from './drivers/tcp.js';

export type BuiltinPrinterConfig = EscPosTcpConfig | EscPosSerialConfig | ConsolePrinterConfig | FilePrinterConfig;

/** Config for a registered vendor driver: { driver: '<name>', options: {...} }. */
export interface VendorPrinterConfig {
  driver: string;
  options?: Record<string, unknown>;
}

export type PrinterConfig = BuiltinPrinterConfig | VendorPrinterConfig;

export interface FiscalDeviceDriver {
  /** Unique driver name used in PrinterConfig.driver. */
  readonly name: string;
  readonly vendor?: string;
  readonly description?: string;
  /** True when the device model is on the ZRA approved fiscal device list (informational). */
  readonly zraApproved?: boolean;
  /** Create a printer for the given device options. Should not perform I/O (connect lazily). */
  createPrinter(options: Record<string, unknown>): ReceiptPrinter;
  /**
   * Optional: devices that sign receipts themselves (fiscal printer / ESD) can expose a
   * FiscalClient so the edge gateway signs through the device instead of the VSDC.
   */
  createFiscalClient?(options: Record<string, unknown>): FiscalClient;
}

const BUILTIN = new Set(['escpos-tcp', 'escpos-serial', 'console', 'file']);
const registry = new Map<string, FiscalDeviceDriver>();

export function registerFiscalDeviceDriver(driver: FiscalDeviceDriver): void {
  if (!driver.name) throw new TypeError('FiscalDeviceDriver.name is required');
  if (BUILTIN.has(driver.name)) throw new Error(`'${driver.name}' is a built-in driver name`);
  if (registry.has(driver.name)) throw new Error(`Fiscal device driver '${driver.name}' already registered`);
  registry.set(driver.name, driver);
}

export function unregisterFiscalDeviceDriver(name: string): boolean {
  return registry.delete(name);
}

export function getFiscalDeviceDriver(name: string): FiscalDeviceDriver | undefined {
  return registry.get(name);
}

export function listFiscalDeviceDrivers(): Array<Pick<FiscalDeviceDriver, 'name' | 'vendor' | 'description' | 'zraApproved'>> {
  return [...registry.values()].map(({ name, vendor, description, zraApproved }) => ({ name, vendor, description, zraApproved }));
}

/** Create a ReceiptPrinter from config (built-in or registered vendor driver). */
export function createPrinter(cfg: PrinterConfig): ReceiptPrinter {
  switch (cfg.driver) {
    case 'escpos-tcp':
      return new EscPosTcpPrinter(cfg as EscPosTcpConfig);
    case 'escpos-serial':
      return new EscPosSerialPrinter(cfg as EscPosSerialConfig);
    case 'console':
      return new ConsolePrinter(cfg as ConsolePrinterConfig);
    case 'file':
      return new FilePrinter(cfg as FilePrinterConfig);
  }
  const vendor = registry.get(cfg.driver);
  if (!vendor) throw new Error(`Unknown printer driver '${cfg.driver}' (built-in: ${[...BUILTIN].join(', ')}; registered: ${[...registry.keys()].join(', ') || 'none'})`);
  return vendor.createPrinter((cfg as VendorPrinterConfig).options ?? {});
}

/**
 * Parse printer config from environment variables:
 *   PRINTER_DRIVER=escpos-tcp|escpos-serial|console|file|<vendor>
 *   PRINTER_HOST, PRINTER_PORT, PRINTER_SERIAL_PATH, PRINTER_BAUD_RATE, PRINTER_DIR, PRINTER_WIDTH,
 *   PRINTER_OPTIONS (JSON, vendor drivers)
 */
export function printerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PrinterConfig {
  const driver = env.PRINTER_DRIVER ?? 'console';
  const width = env.PRINTER_WIDTH ? Number(env.PRINTER_WIDTH) : undefined;
  switch (driver) {
    case 'escpos-tcp':
      return { driver, host: env.PRINTER_HOST ?? '', port: env.PRINTER_PORT ? Number(env.PRINTER_PORT) : undefined, render: { width } };
    case 'escpos-serial':
      return { driver, path: env.PRINTER_SERIAL_PATH ?? '', baudRate: env.PRINTER_BAUD_RATE ? Number(env.PRINTER_BAUD_RATE) : undefined, render: { width } };
    case 'file':
      return { driver, dir: env.PRINTER_DIR ?? './receipts', width };
    case 'console':
      return { driver, width };
    default:
      return { driver, options: env.PRINTER_OPTIONS ? (JSON.parse(env.PRINTER_OPTIONS) as Record<string, unknown>) : {} };
  }
}
