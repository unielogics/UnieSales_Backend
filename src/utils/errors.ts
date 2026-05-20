export interface ErrorDetail {
  field?: string;
  reason: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errors: ErrorDetail[];
  public readonly publicMessage: string;

  constructor(message: string, statusCode = 500, errors: ErrorDetail[] = []) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errors = errors;
    this.publicMessage = message;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, errors: ErrorDetail[] = []) {
    super(message, 400, errors);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, errors: ErrorDetail[] = []) {
    super(message, 409, errors);
    this.name = 'ConflictError';
  }
}
