export class Logger {
  private plain: boolean = false;
  private verbose: boolean = false;

  constructor(options?: { plain?: boolean; verbose?: boolean }) {
    if (options) {
      this.plain = !!options.plain;
      this.verbose = !!options.verbose;
    }
  }

  public setPlain(plain: boolean): void {
    this.plain = plain;
  }

  public setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  private color(code: string, text: string): string {
    if (this.plain || !process.stdout.isTTY) {
      return text;
    }
    return `\x1b[${code}m${text}\x1b[0m`;
  }

  public info(message: string): void {
    console.log(this.color('36', 'ℹ ') + message);
  }

  public success(message: string): void {
    console.log(this.color('32', '✔ ') + message);
  }

  public warn(message: string): void {
    console.warn(this.color('33', '⚠ ') + message);
  }

  public error(message: string): void {
    console.error(this.color('31', '✖ ') + message);
  }

  public debug(message: string): void {
    if (this.verbose) {
      console.log(this.color('90', '🔍 [DEBUG] ') + this.color('90', message));
    }
  }

  public stage(current: number, total: number, message: string): void {
    const prefix = `[${current}/${total}]`;
    console.log(`\n` + this.color('1;35', prefix) + ' ' + this.color('1', message));
  }

  public table(data: Record<string, string | number | undefined | null>): void {
    const keys = Object.keys(data);
    const maxKeyLen = Math.max(...keys.map((k) => k.length), 0);

    for (const key of keys) {
      const val = data[key] ?? '-';
      const paddedKey = key.padEnd(maxKeyLen);
      console.log(`  ${this.color('90', paddedKey)} : ${val}`);
    }
  }

  public raw(text: string): void {
    console.log(text);
  }
}

export const logger = new Logger();
