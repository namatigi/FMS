export { renderReceiptText, receiptBlocks, vatLines, formatSaleTime, wrap, pairLines, alignLine, type ReceiptBlock, type RenderOptions } from './render.js';
export {
  EscPosBuilder,
  buildEscPosReceipt,
  toPrinterBytes,
  decodePaperStatus,
  PAPER_STATUS_REQUEST,
  ESC,
  GS,
  LF,
  DLE,
  EOT,
  type Align,
  type QrErrorLevel,
  type EscPosRenderOptions,
} from './escpos.js';
export { EscPosTcpPrinter, type EscPosTcpConfig } from './drivers/tcp.js';
export { EscPosSerialPrinter, type EscPosSerialConfig } from './drivers/serial.js';
export { ConsolePrinter, FilePrinter, safeFileName, type ConsolePrinterConfig, type FilePrinterConfig } from './drivers/simple.js';
export {
  createPrinter,
  printerConfigFromEnv,
  registerFiscalDeviceDriver,
  unregisterFiscalDeviceDriver,
  getFiscalDeviceDriver,
  listFiscalDeviceDrivers,
  type FiscalDeviceDriver,
  type PrinterConfig,
  type BuiltinPrinterConfig,
  type VendorPrinterConfig,
} from './registry.js';
