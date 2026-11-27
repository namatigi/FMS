# @fms/fiscal-printer

This package renders fuel receipts and sends them to printers. It provides:
- a text layout of the receipt
- ESC/POS output with a ZRA QR code
- printer drivers
- a plug-in registry for vendor ZRA-approved fiscal devices

## API

```ts
import { renderReceiptText, buildEscPosReceipt, createPrinter, registerFiscalDeviceDriver } from '@fms/fiscal-printer';

renderReceiptText(doc /* ReceiptDocument */, 42);   // 42 columns = 80 mm, 32 = 58 mm
buildEscPosReceipt(doc, { width: 42, qrModuleSize: 6 });   // Buffer

const printer = createPrinter({ driver: 'escpos-tcp', host: '192.168.1.50', port: 9100 });
// { driver: 'escpos-serial', path: '/dev/ttyUSB0', baudRate: 9600 }   (needs optional `serialport`)
// { driver: 'console' }  |  { driver: 'file', dir: './receipts', format: 'text'|'escpos'|'both' }
await printer.print(doc);
await printer.status();   // { online, paper: 'ok'|'low'|'out'|'unknown' }  (ESC/POS: DLE EOT 4)
```

`printerConfigFromEnv()` reads its settings from these environment variables:
- `PRINTER_DRIVER`
- `PRINTER_HOST` and `PRINTER_PORT`
- `PRINTER_SERIAL_PATH` and `PRINTER_BAUD_RATE`
- `PRINTER_DIR`
- `PRINTER_WIDTH`
- `PRINTER_OPTIONS`, as JSON, for vendor drivers

## Receipt layout

The receipt prints these sections, in order:
1. Station name (bold, double size), address, TPIN and "TAX INVOICE"
2. Invoice number, date (Africa/Lusaka), pump and nozzle, attendant
3. Each product with `litres L x price` and its amount
4. VAT breakdown per category (taxable amount and VAT, tax-inclusive), total VAT, **TOTAL ZMW**, payment
5. The ZRA block: SDC ID, receipt number and total receipt number, internal data, receipt signature, MRC number, signed time and the **QR code** with the ZRA URL
6. Footer

## ESC/POS

The ESC/POS bytes are built in-house, with no dependencies:
- `ESC @` initialise and `ESC t 0` code page PC437. Text is normalised to ASCII.
- `ESC a n` alignment, `ESC E n` bold and `GS ! n` size.
- QR code through `GS ( k`: model 2 (`31 41`), module size (`31 43`), error level M (`31 45`), store (`31 50 30`) and print (`31 51 30`).
- `GS V 66 n` feed and partial cut.
- Paper status through `DLE EOT 4`.

## Vendor fiscal devices (`FiscalDeviceDriver`)

ZRA may require certified fiscal printers or Electronic Signature Devices (DESIGN §12 item 3). A vendor driver plugs in without changing any FMS code:

```ts
registerFiscalDeviceDriver({
  name: 'acme-fp200',            // used as PrinterConfig.driver
  vendor: 'ACME', zraApproved: true,
  createPrinter(options) { return new AcmeFp200Printer(options); },        // must implement ReceiptPrinter
  createFiscalClient(options) { return new AcmeFp200Signer(options); },    // optional: device signs (FiscalClient)
});
const printer = createPrinter({ driver: 'acme-fp200', options: { host: '10.0.0.5' } });
```

The registry rules are:
- `createPrinter` must not do I/O, so connections open lazily on `print()` or `status()`.
- Built-in names (`escpos-tcp`, `escpos-serial`, `console`, `file`) are reserved.
- `listFiscalDeviceDrivers()` lists the registered drivers.

## Build and test

```bash
npm install && npm test   # text layout, ESC/POS (QR + cut), TCP driver against a local net.Server, file/console, registry
```
