export class SystemTime {
  private generator: () => Date = () => new Date();

  now(): Date {
    return this.generator();
  }

  constant(date: Date): void {
    const n = date.valueOf();
    this.generator = () => new Date(n);
  }

  system(): void {
    this.generator = () => new Date();
  }

  advance(millis = 1): void {
    const next = this.now();
    next.setTime(next.getTime() + millis);
    this.constant(next);
  }

  custom(generator: () => Date): void {
    this.generator = generator;
  }
}
