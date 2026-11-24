import { appendErrorLocation } from '../protocol/error-location';

interface RemotePreviewProperty {
  name: string;
  type: string;
  subtype?: string;
  value?: string;
}

export interface EvaluationException {
  text: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: {
    type?: string;
    subtype?: string;
    className?: string;
    description?: string;
    value?: unknown;
    unserializableValue?: string;
    preview?: { properties: RemotePreviewProperty[]; overflow?: boolean };
  };
}

const PREVIEW_CHARS = 2000;
const PREVIEW_PROPERTIES = 5;

function bounded(text: string) {
  if (text.length <= PREVIEW_CHARS) return text;
  const suffix = '… [truncated]';
  let end = PREVIEW_CHARS - suffix.length;
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end) + suffix;
}

function previewValue(property: RemotePreviewProperty) {
  if (property.type === 'string') return JSON.stringify(property.value ?? '');
  if (property.type === 'undefined') return 'undefined';
  if (property.subtype === 'null') return 'null';
  if (property.type === 'accessor') return '[accessor]';
  if (property.type === 'object' || property.type === 'function')
    return `[${property.value ?? property.subtype ?? property.type}]`;
  return property.value ?? `[${property.type}]`;
}

/** Fill proven gaps in the existing message; never copy its stack into a second error field. */
export function evaluationExceptionMessage(details: EvaluationException): string {
  const exception = details.exception;
  if (!exception || !exception.type || exception.subtype === 'error') {
    const message = exception?.description ?? details.text;
    if (exception?.className !== 'SyntaxError') return message;
    const { lineNumber, columnNumber } = details;
    if (typeof lineNumber !== 'number' || !Number.isSafeInteger(lineNumber) || lineNumber < 0)
      return message;
    return appendErrorLocation(message, {
      line: lineNumber + 1,
      column:
        typeof columnNumber === 'number' && Number.isSafeInteger(columnNumber) && columnNumber >= 0
          ? columnNumber + 1
          : undefined,
    });
  }
  if (exception.unserializableValue !== undefined)
    return bounded(`Thrown value: ${exception.unserializableValue}`);
  if (Object.hasOwn(exception, 'value'))
    return bounded(`Thrown value: ${JSON.stringify(exception.value) ?? 'undefined'}`);
  if (exception.type === 'undefined') return 'Thrown value: undefined';
  const properties = exception.preview?.properties ?? [];
  if (properties.length || exception.preview?.overflow) {
    const items = properties
      .slice(0, PREVIEW_PROPERTIES)
      .map((property) => `${JSON.stringify(property.name)}: ${previewValue(property)}`);
    if (exception.preview?.overflow || properties.length > PREVIEW_PROPERTIES) items.push('…');
    return bounded(
      `Thrown value (${exception.description ?? exception.className ?? exception.type} preview): {${items.join(', ')}}`,
    );
  }
  return bounded(`Thrown value: ${exception.description ?? exception.className ?? exception.type}`);
}
