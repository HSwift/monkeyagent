import type { UIMessage } from 'ai';

/** Older streams had empty assistant IDs; repair only invalid/duplicate IDs on load. */
export function normalizeMessageIds(messages: UIMessage[]): UIMessage[] {
  const seen = new Set<string>();
  return messages.map((message) => {
    let id = message.id;
    if (!id || seen.has(id)) id = crypto.randomUUID();
    seen.add(id);
    return id === message.id ? message : { ...message, id };
  });
}

export function toolInputHint(toolName: string) {
  const inputs: Record<string, string> = {
    Read: 'file_path; optional offset (1-based line), limit (lines)',
    Write: 'file_path, content',
    Edit: 'file_path, old_string, new_string; optional replace_all',
    Glob: 'pattern; optional path',
    Grep: 'pattern; optional path, glob, output_mode',
    files: 'Legacy files requires op; use Read/Write/Edit/Glob/Grep for new calls',
    repl: 'code as a JavaScript string; optional timeout (50–60000 ms) and description',
  };
  return `Invalid ${toolName} arguments. Expected: ${inputs[toolName] ?? 'a registered tool name'}. Script paths start with /workspace/. Read /docs/agent-guide.md and resend a corrected call.`;
}
