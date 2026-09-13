export class InspectionExecutionError extends Error {
  readonly code: string;
  readonly details: string | undefined;

  constructor(code: string, message: string, details?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InspectionExecutionError";
    this.code = code;
    this.details = details;
  }
}

export class InspectionCancelledError extends InspectionExecutionError {
  constructor(message = "Inspection was cancelled before it completed.") {
    super("cancelled", message);
    this.name = "InspectionCancelledError";
  }
}
