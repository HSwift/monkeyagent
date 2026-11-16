import { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import type { MergeView } from '@codemirror/merge';

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', background: 'var(--surface)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', overflow: 'auto' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--text)' },
  '.cm-gutters': {
    background: 'var(--surface)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': { background: 'var(--hover)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: 'var(--selection)',
  },
});
export function CodeEditor({
  value,
  onChange,
  onSelection,
  readOnly = false,
  label = 'Code editor',
  onRun,
}: {
  value: string;
  onChange?: (value: string) => void;
  onSelection?: (value: string) => void;
  readOnly?: boolean;
  label?: string;
  onRun?: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSelection, onRun });
  callbacks.current = { onChange, onSelection, onRun };
  const editable = useRef(new Compartment());
  useEffect(() => {
    const editor = (view.current = new EditorView({
      parent: element.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          javascript(),
          editorTheme,
          editable.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                callbacks.current.onRun?.();
                return !!callbacks.current.onRun;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              update.transactions.some(
                (tx) =>
                  tx.isUserEvent('input') ||
                  tx.isUserEvent('delete') ||
                  tx.isUserEvent('undo') ||
                  tx.isUserEvent('redo'),
              )
            )
              callbacks.current.onChange?.(update.state.doc.toString());
            if (update.selectionSet) {
              const range = update.state.selection.main;
              callbacks.current.onSelection?.(update.state.sliceDoc(range.from, range.to));
            }
          }),
        ],
      }),
    }));
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && value !== editor.state.doc.toString())
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);
  return <div className="code-editor" ref={element} />;
}
export function DiffEditor({ before, after }: { before: string; after: string }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let editor: MergeView | undefined;
    let disposed = false;
    void import('@codemirror/merge').then(({ MergeView }) => {
      if (disposed) return;
      editor = new MergeView({
        parent: element.current!,
        a: {
          doc: before,
          extensions: [basicSetup, javascript(), editorTheme, EditorState.readOnly.of(true)],
        },
        b: {
          doc: after,
          extensions: [basicSetup, javascript(), editorTheme, EditorState.readOnly.of(true)],
        },
        highlightChanges: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      });
    });
    return () => {
      disposed = true;
      editor?.destroy();
    };
  }, [before, after]);
  return <div className="diff-editor" ref={element} />;
}
