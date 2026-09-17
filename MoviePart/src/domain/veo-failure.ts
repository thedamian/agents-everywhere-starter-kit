import { MovieError } from "./index";

const recovery = "This operation has ended without a usable clip; retrying it cannot restart generation. The saved plan, references and operation ID are retained. Any new take requires explicit approval and may incur a new charge.";
const failures = {
  VEO_GENERATION_FAILED: "Google Veo returned no usable clip. The available error does not identify whether this was filtering or another provider failure.",
  VEO_CONTENT_FILTERED: "Google Veo filtered the hero clip under its safety rules. Review the content and provider policy before requesting a new take.",
  VEO_OPERATION_INVALID: "Google Veo reported invalid input for this operation. Check the selected model and supported image/video settings.",
  VEO_OPERATION_ACCESS: "Google Veo reported an authentication or permission failure for this operation. Check Google credentials and model access.",
  VEO_OPERATION_QUOTA: "Google Veo reported exhausted quota or capacity for this operation. Check Google project quota and billing before another submission.",
  VEO_OPERATION_UNAVAILABLE: "Google Veo reported an internal error, unavailability or deadline failure for this operation.",
  VEO_OPERATION_CANCELLED: "Google Veo reported that this video operation was cancelled.",
  VEO_OPERATION_PRECONDITION: "Google Veo reported an unmet precondition for this operation. Check the selected model's requirements and account configuration.",
  VEO_OPERATION_NOT_FOUND: "Google Veo reported that a resource required by this operation was not found.",
} as const;
type FailureCode = keyof typeof failures;

export function terminalVeoMessage(code: string | undefined): string | null {
  return code && Object.hasOwn(failures, code) ? `${failures[code as FailureCode]} ${recovery}` : null;
}

export function assertVeoRecoverable(code: string | undefined): void {
  const message = terminalVeoMessage(code);
  if (message) throw new MovieError("VEO_OPERATION_TERMINAL", message, 409);
}

export function veoSubmissionFailure(error: unknown): MovieError {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
  if (status === 400) {
    return new MovieError("VEO_SUBMISSION_INVALID",
      "Google Veo rejected the request parameters. Confirm an enabled Veo 3.1 model and supported 8-second, 16:9, 720p first/last-frame inputs before submitting again.", 502);
  }
  if (status === 401 || status === 403) {
    return new MovieError("VEO_SUBMISSION_ACCESS",
      "Google Veo rejected the credential or project access. Confirm the Gemini API key, its API restrictions, paid-tier billing, and Veo model access before submitting again.", 502);
  }
  if (status === 404) {
    return new MovieError("VEO_SUBMISSION_MODEL",
      "The configured Google Veo model is not available to this API project. Confirm VEO_MODEL and model availability in Google AI Studio before submitting again.", 502);
  }
  if (status === 429) {
    return new MovieError("VEO_SUBMISSION_QUOTA",
      "Google Veo rejected the request because project quota, spend capacity, or billing availability was exhausted. Check the project's Veo rate limits and billing before submitting again.", 502);
  }
  if (status !== undefined && status >= 500) {
    return new MovieError("VEO_SUBMISSION_UNAVAILABLE",
      "Google Veo was temporarily unavailable while accepting the request. No operation ID was returned; inspect Google service status before authorizing another paid submission.", 502);
  }
  return new MovieError("VEO_WORKFLOW_FAILED",
    "The Google Veo workflow could not finish submission. No operation ID was returned; run npm run veo:check and inspect Google AI Studio billing and rate limits before authorizing another paid submission.", 502);
}

export function veoOperationFailure(operation: {
  error?: unknown;
  response?: { raiMediaFilteredCount?: number; raiMediaFilteredReasons?: string[] };
}): MovieError | null {
  let code: FailureCode;
  if ((operation.response?.raiMediaFilteredCount ?? 0) > 0 || (operation.response?.raiMediaFilteredReasons?.length ?? 0) > 0) {
    code = "VEO_CONTENT_FILTERED";
  } else if (operation.error) {
    const error = typeof operation.error === "object" && operation.error !== null ? operation.error : {};
    const status = "status" in error ? error.status : undefined;
    const numeric = "code" in error ? error.code : undefined;
    const categories: { status: string; number: number; code: FailureCode }[] = [
      { status: "CANCELLED", number: 1, code: "VEO_OPERATION_CANCELLED" },
      { status: "INVALID_ARGUMENT", number: 3, code: "VEO_OPERATION_INVALID" },
      { status: "DEADLINE_EXCEEDED", number: 4, code: "VEO_OPERATION_UNAVAILABLE" },
      { status: "NOT_FOUND", number: 5, code: "VEO_OPERATION_NOT_FOUND" },
      { status: "PERMISSION_DENIED", number: 7, code: "VEO_OPERATION_ACCESS" },
      { status: "RESOURCE_EXHAUSTED", number: 8, code: "VEO_OPERATION_QUOTA" },
      { status: "FAILED_PRECONDITION", number: 9, code: "VEO_OPERATION_PRECONDITION" },
      { status: "INTERNAL", number: 13, code: "VEO_OPERATION_UNAVAILABLE" },
      { status: "UNAVAILABLE", number: 14, code: "VEO_OPERATION_UNAVAILABLE" },
      { status: "UNAUTHENTICATED", number: 16, code: "VEO_OPERATION_ACCESS" },
    ];
    code = categories.find(category => category.status === status || category.number === numeric)?.code ?? "VEO_GENERATION_FAILED";
  } else {
    return null;
  }
  // Provider messages and filter-reason text can include private prompts or credentials.
  return new MovieError(code, terminalVeoMessage(code)!, 502);
}
