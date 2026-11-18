# Open source components

Dependencies are pinned in package.json and the repository pnpm lockfile. All executable code and WASM are bundled locally.

| Component                                   | Source                                                 | License    | Use                                                                   |
| ------------------------------------------- | ------------------------------------------------------ | ---------- | --------------------------------------------------------------------- |
| AI SDK / AI SDK React / compatible provider | https://github.com/vercel/ai                           | Apache-2.0 | ToolLoopAgent, useChat, streaming, model transport                    |
| React                                       | https://github.com/facebook/react                      | MIT        | Frontend                                                              |
| Radix UI                                    | https://github.com/radix-ui/primitives                 | MIT        | Dialog/Sheet, Tabs, Tooltip, Collapsible, Scroll Area                 |
| shadcn/ui patterns                          | https://github.com/shadcn-ui/ui                        | MIT        | Composition patterns for accessible primitives and AI chat/tool views |
| CodeMirror 6 / merge                        | https://code.haverbeke.berlin/codemirror/dev           | MIT        | Editing and diffs                                                     |
| quickjs-emscripten                          | https://github.com/justjake/quickjs-emscripten         | MIT        | Isolated JavaScript runtime and packaged QuickJS WASM                 |
| idb                                         | https://github.com/jakearchibald/idb                   | ISC        | IndexedDB transactions                                                |
| Zod                                         | https://github.com/colinhacks/zod                      | MIT        | Tool schemas                                                          |
| react-resizable-panels                      | https://github.com/bvaughn/react-resizable-panels      | MIT        | Keyboard/pointer pane resizing                                        |
| use-stick-to-bottom                         | https://github.com/stackblitz-labs/use-stick-to-bottom | MIT        | Chat scroll behavior                                                  |
| Lucide                                      | https://github.com/lucide-icons/lucide                 | ISC        | Icons                                                                 |
| react-markdown                              | https://github.com/remarkjs/react-markdown             | MIT        | Response rendering without raw HTML                                   |
| remark-gfm                                  | https://github.com/remarkjs/remark-gfm                 | MIT        | GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks) |
| Lezer highlight                             | https://github.com/lezer-parser/highlight              | MIT        | Static syntax highlighting of chat code blocks                        |
| clsx                                        | https://github.com/lukeed/clsx                         | MIT        | Class composition                                                     |
| picomatch                                   | https://github.com/micromatch/picomatch                | MIT        | Glob pattern matching                                                 |
| RE2JS                                       | https://github.com/le0pard/re2js                       | MIT        | Browser regex search without backtracking                              |

`src/components/ui.tsx` and `src/components/conversation.tsx` are local compositions using the shadcn/ui and AI Elements patterns, with actual behavior delegated to the libraries above. They are not unmodified copies of upstream registry files. Business logic lives in the panel/controller services. Package distributions retain their upstream licenses; production packaging should retain this notice alongside the bundled artifacts.
