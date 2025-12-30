import { useRef, useState, useCallback, createContext, useContext, useMemo, useEffect, memo } from "react";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";
import * as htmlToImage from "html-to-image";
import type { Node, Edge, NodeProps } from "reactflow";
/* layout constants */
const GAP_X = 200;
// Increase vertical gap so nodes with larger default height don't overlap
const GAP_Y = 300;
// Increase horizontal subtree gap to avoid children touching each other
const SUBTREE_GAP = 80;
// Zoom controls
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.2;
const ROOT_X = 400;
const ROOT_Y = 40;
const ADD_COOLDOWN = 200;
const DEFAULT_NODE_WIDTH = 320;
const DEFAULT_NODE_HEIGHT = 140;
const STORAGE_KEY = "pyramid-tool-nodes";

/* =====================
   型定義
===================== */
type TextNodeData = {
  id: string;
  parentId: string | null;
  label: string;
  width?: number;
  height?: number;
};

type NodeActions = {
  setLabel: (id: string, value: string) => void;
  addChild: (id: string) => void;
  deleteNode: (id: string) => void;
  setNodeSize: (id: string, width: number, height: number) => void;
  isAddDisabled: (id: string) => boolean;
};

/* =====================
   Context（★Appの外）
===================== */
const NodeActionContext = createContext<NodeActions | null>(null);

function useNodeActions() {
  const ctx = useContext(NodeActionContext);
  if (!ctx) throw new Error("NodeActionContext is missing");
  return ctx;
}

/* =====================
   ノードUI（表示専用）
===================== */
function TextNodeImpl({ id, data }: NodeProps<TextNodeData>) {
  const { setLabel, addChild, deleteNode, setNodeSize } = useNodeActions();

  // textarea ref and local state to preserve caret/selection while typing
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [localValue, setLocalValue] = useState(data.label);
  const [isEditing, setIsEditing] = useState(false);
  const [isComposing, setIsComposing] = useState(false);

  // store selection while we might update the value
  const selRef = useRef<{ start: number | null; end: number | null }>({
    start: null,
    end: null,
  });

  // Sync from external data only when not editing/composing to avoid clobbering
  useEffect(() => {
    if (isEditing || isComposing) return;

    const ta = taRef.current;
    const isFocused = ta && document.activeElement === ta;

    if (isFocused && ta) {
      // 保存
      selRef.current.start = ta.selectionStart;
      selRef.current.end = ta.selectionEnd;
    }

    setLocalValue(data.label);

    // restore on next frame if focused
    if (isFocused) {
      requestAnimationFrame(() => {
        const t = taRef.current;
        if (!t) return;
        try {
          const s = selRef.current.start ?? 0;
          const e = selRef.current.end ?? s;
          t.setSelectionRange(s, e);
          t.focus();
        } catch (err) {
          // ignore
        }
      });
    }
  }, [data.label, isEditing, isComposing]);

  // Observe size changes of the node container (including textarea resize)
  useEffect(() => {
    // Disabled automatic relayout on resize: measuring textarea and
    // immediately triggering layout caused intermittent layout failures
    // that could wipe the tree. To keep the tree stable we no longer
    // auto-call setNodeSize here. If you want to re-run layout, use
    // the "再配置" button provided in the UI.
    return;
  }, [id, setNodeSize]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setLocalValue(v);
    // If composing with IME, avoid sending intermediate values to parent to
    // prevent re-renders that break composition. Sync on compositionend.
    if (!isComposing) {
      setLabel(id, v);
    }
  };

  const handleCompositionStart = () => setIsComposing(true);
  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    setIsComposing(false);
    // finalize value to parent
    setLabel(id, (e.target as HTMLTextAreaElement).value);
  };

  return (
    <div
      className="nodrag nopan"
      style={{
        padding: 8,
        border: "1px solid #555",
        background: "#fff",
        borderRadius: 4,
        minWidth: DEFAULT_NODE_WIDTH,
      }}
      ref={containerRef}

      /* ★ ここが最重要 */
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Handle type="target" position={Position.Top} />

      <textarea
        ref={taRef}
        style={{ width: "100%", resize: 'both', overflow: 'auto', minHeight: DEFAULT_NODE_HEIGHT }}
        value={localValue}
        onChange={handleChange}
        onFocus={() => setIsEditing(true)}
        onBlur={() => setIsEditing(false)}

        /* キー・IME だけ止める（React Flow に伝搬させない） */
        onKeyDownCapture={(e) => e.stopPropagation()}
        onKeyUpCapture={(e) => e.stopPropagation()}
        onCompositionStartCapture={(e) => e.stopPropagation()}
        onCompositionUpdateCapture={(e) => e.stopPropagation()}
        onCompositionEndCapture={(e) => e.stopPropagation()}

        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
      />

      <div style={{ textAlign: "center", marginTop: 4, display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            addChild(id);
          }}
        >
          ＋
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            // prevent deleting root
            if (data.parentId === null) return;
            deleteNode(id);
          }}
          title={data.parentId === null ? 'ルートは削除できません' : 'このノードを削除'}
        >
          －
        </button>
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const TextNode = memo(
  TextNodeImpl,
  (prev: NodeProps<TextNodeData>, next: NodeProps<TextNodeData>) => {
    // Re-render when label or measured size changes. Prevent hiding due to stale DOM.
    return (
      prev.id === next.id &&
      prev.data.label === next.data.label &&
      prev.data.width === next.data.width &&
      prev.data.height === next.data.height
    );
  }
);


/* =====================
   メイン App
===================== */
export default function App() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<any>(null);
  const lastAddRef = useRef<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [exportFilename, setExportFilename] = useState<string>("pyramid");

  // localStorageから初期データを読み込む関数
  const loadInitialNodes = (): Node<TextNodeData>[] => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Node<TextNodeData>[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn('localStorage読み込み失敗:', err);
    }
    // デフォルト値
    return [
      {
        id: "root",
        type: "text",
        position: { x: 400, y: 40 },
        data: {
          id: "root",
          parentId: null,
          label: "ここに結論・主張を入力",
          width: DEFAULT_NODE_WIDTH,
          height: DEFAULT_NODE_HEIGHT,
        },
      },
    ];
  };

  const [nodes, setNodes] = useState<Node<TextNodeData>[]>(() => loadInitialNodes());

  // nodesが変更されたらlocalStorageに自動保存
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes));
    } catch (err) {
      console.warn('localStorage保存失敗:', err);
    }
  }, [nodes]);

  const nodeTypes = useMemo(() => ({ text: TextNode }), []);

  /* ----- ノード操作 ----- */
  const setLabel = useCallback((id: string, value: string) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, label: value } } : n
      )
    );
  }, []);

  const addChild = useCallback((parentId: string) => {
    const now = Date.now();
    const last = lastAddRef.current[parentId] || 0;
    if (now - last < ADD_COOLDOWN) return;

    setNodes((prev) => {
      try {
        const parent = prev.find((n) => n.id === parentId);
        if (!parent) return prev;

  // prevent explosion: limit number of direct children per parent
  const directChildren = prev.filter((n) => n.data.parentId === parentId).length;
  if (directChildren >= 5) return prev;

  // global node cap
  const GLOBAL_NODE_CAP = 200;
  if (prev.length >= GLOBAL_NODE_CAP) return prev;

        const childId = crypto.randomUUID();

  const parentX = Number.isFinite(parent.position?.x) ? parent.position.x : ROOT_X;
  const parentY = Number.isFinite(parent.position?.y) ? parent.position.y : ROOT_Y;

        const nextCandidates: Node<TextNodeData>[] = [
          ...prev,
          {
            id: childId,
            type: "text",
            position: {
              x: parentX,
              y: parentY + GAP_Y,
            },
            data: {
              id: childId,
              parentId,
              label: "理由を書く",
              width: DEFAULT_NODE_WIDTH,
              height: DEFAULT_NODE_HEIGHT,
            },
          },
        ];
        // attempt layout
  const laid = layoutTree(nextCandidates, "root", ROOT_X, ROOT_Y);

        // basic sanity checks: layout must return array and contain root and new child
        if (!Array.isArray(laid) || laid.length === 0) {
          console.warn('addChild: layoutTree returned empty or non-array, aborting');
          return prev;
        }
        const hasRoot = laid.some((n) => n.id === 'root');
        const hasChild = laid.some((n) => n.id === childId);
        if (!hasRoot || !hasChild) {
          console.warn('addChild: layoutTree result missing root or child, aborting', { hasRoot, hasChild });
          return prev;
        }

        // update lastAddRef only when add succeeds to avoid disabling the button on failed attempts
        lastAddRef.current[parentId] = now;

        return laid;
      } catch (err) {
        console.error('addChild failed', err);
        return prev;
      }
    });
  }, []);

  const isAddDisabled = useCallback((id: string) => {
    const last = lastAddRef.current[id] || 0;
    return Date.now() - last < ADD_COOLDOWN;
  }, []);

  const deleteNode = useCallback((id: string) => {
    setNodes((prev) => {
      // do not allow deleting the root
  if (id === 'root') return prev;

      const toRemove = new Set<string>([id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of prev) {
          if (!toRemove.has(n.id) && n.data.parentId && toRemove.has(n.data.parentId)) {
            toRemove.add(n.id);
            changed = true;
          }
        }
      }

      const next = prev.filter((n) => !toRemove.has(n.id));
      try {
        return layoutTree(next, 'root', ROOT_X, ROOT_Y);
      } catch (err) {
        console.error('layoutTree failed during deleteNode', err);
        return prev;
      }
    });
  }, []);

  const setNodeSize = useCallback((id: string, width: number, height: number) => {
    // Only store the measured size. Do NOT trigger an automatic relayout
    // here — that has caused state wipe issues. Call the manual relayout
    // action when a stable relayout is desired.
    setNodes((prev) => {
      const w = Number.isFinite(width) ? Math.max(80, Math.min(width, 2000)) : GAP_X;
      const h = Number.isFinite(height) ? Math.max(24, Math.min(height, 2000)) : 40;
      return prev.map((n) => (n.id === id ? { ...n, data: { ...n.data, width: w, height: h } } : n));
    });
  }, []);

  /* ----- エッジ生成 ----- */
  const edges: Edge[] = nodes
    .filter((n) => n.data.parentId)
    .map((n) => ({
      id: `e-${n.data.parentId}-${n.id}`,
      source: n.data.parentId!,
      target: n.id,
      type: "smoothstep",
    }));

  /* ----- 画像出力 ----- */
  const exportImage = async () => {
    if (!wrapperRef.current) return;
    try {
      const png = await (htmlToImage as any).toPng(wrapperRef.current, {
        backgroundColor: '#ffffff',
        pixelRatio: 2,
      });
      const a = document.createElement('a');
      a.href = png;
      a.download = 'pyramid.png';
      a.click();
    } catch (err) {
      console.error('exportImage failed', err);
    }
  };

  /* ----- JSON 出力 / 読込 ----- */
  const nodesToMarkdown = useCallback((nodesArr: Node<TextNodeData>[]) => {
    // build map of children
    const map = new Map<string | null, Node<TextNodeData>[]>();
    for (const n of nodesArr) {
      const p = n.data.parentId ?? null;
      if (!map.has(p)) map.set(p, []);
      map.get(p)!.push(n);
    }

    const sb: string[] = [];
    const write = (parentId: string | null, depth: number) => {
      const children = map.get(parentId) || [];
      for (const c of children) {
        const indent = '  '.repeat(depth);
        const label = (c.data.label || '').replace(/\n/g, ' ');
        sb.push(`${indent}- ${label}`);
        write(c.id, depth + 1);
      }
    };

    write(null, 0);
    return sb.join('\n');
  }, []);

  const exportMarkdown = useCallback(() => {
    try {
      const filename = (exportFilename || "pyramid").trim() || "pyramid";
      const base = filename.split('.')[0];
      const outName = `${base}.md`;
      const md = nodesToMarkdown(nodes);
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('exportMarkdown failed', err);
      alert('MD 出力に失敗しました');
    }
  }, [nodes, exportFilename, nodesToMarkdown]);

  const parseMarkdownToNodes = useCallback((txt: string) => {
    const lines = txt.split(/\r?\n/);
    const nodesOut: Node<TextNodeData>[] = [];
    const lastAtDepth: Record<number, string> = {};
    for (const raw of lines) {
      const m = raw.match(/^(\s*)[-*]\s+(.*)$/);
      if (!m) continue;
      const leading = m[1] || '';
      const label = m[2].trim();
      const depth = Math.floor(leading.replace(/\t/g, '  ').length / 2);
      const id = crypto.randomUUID();
      const parentId = depth === 0 ? null : (lastAtDepth[depth - 1] ?? null);
      nodesOut.push({
        id,
        type: 'text',
        position: { x: ROOT_X, y: ROOT_Y },
        data: { id, parentId, label, width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
      });
      lastAtDepth[depth] = id;
    }

    const top = nodesOut.filter((n) => n.data.parentId === null);
    if (top.length === 1) {
      const topNode = top[0];
      const oldId = topNode.id;
      topNode.id = 'root';
      topNode.data.id = 'root';
      for (const n of nodesOut) {
        if (n.data.parentId === oldId) n.data.parentId = 'root';
      }
    } else if (top.length > 1) {
      const rootNode: Node<TextNodeData> = {
        id: 'root',
        type: 'text',
        position: { x: ROOT_X, y: ROOT_Y },
        data: { id: 'root', parentId: null, label: 'root', width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
      };
      for (const t of top) t.data.parentId = 'root';
      nodesOut.unshift(rootNode);
    }

    return nodesOut;
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const txt = await f.text();
      const name = f.name || '';
      if (name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(txt) as Node<TextNodeData>[];
        if (!Array.isArray(parsed)) throw new Error('invalid format');
        const ok = parsed.every((p) => p && typeof p.id === 'string' && p.data && typeof p.data.id === 'string');
        if (!ok) throw new Error('invalid node structure');
        try {
          const laid = layoutTree(parsed, 'root', ROOT_X, ROOT_Y);
          if (!Array.isArray(laid) || laid.length === 0) throw new Error('layout failed');
          setNodes(laid);
        } catch (err) {
          console.warn('layout failed during import, using raw nodes', err);
          setNodes(parsed as Node<TextNodeData>[]);
        }
      } else if (name.toLowerCase().endsWith('.md') || name.toLowerCase().endsWith('.markdown')) {
        const parsed = parseMarkdownToNodes(txt);
        try {
          const laid = layoutTree(parsed, 'root', ROOT_X, ROOT_Y);
          setNodes(laid);
        } catch (err) {
          console.warn('layout failed during md import, using raw nodes', err);
          setNodes(parsed);
        }
      } else {
        const parsed = parseMarkdownToNodes(txt);
        try { setNodes(layoutTree(parsed, 'root', ROOT_X, ROOT_Y)); } catch (err) { setNodes(parsed); }
      }
    } catch (err) {
      console.error(err);
      alert('読み込みに失敗しました: ' + (err as any).message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [parseMarkdownToNodes]);

  const triggerImport = useCallback(() => {
    fileInputRef.current && fileInputRef.current.click();
  }, []);

  // zoom controls: programmatically adjust viewport zoom
  const zoomBy = useCallback((factor: number) => {
    const flow = flowRef.current;
    if (!flow) return;
    try {
      const vp = (flow as any).getViewport ? (flow as any).getViewport() : null;
      if (!vp) return;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, vp.zoom * factor));
      (flow as any).setViewport && (flow as any).setViewport({ x: vp.x, y: vp.y, zoom: newZoom });
    } catch (err) {
      // ignore
    }
  }, []);

  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);

  const fitViewHandler = useCallback(() => {
    const flow = flowRef.current;
    try { (flow as any).fitView && (flow as any).fitView(); } catch (err) {}
  }, []);

  return (
  <NodeActionContext.Provider value={{ setLabel, addChild, deleteNode, setNodeSize, isAddDisabled }}>
      <div style={{ width: "100vw", height: "100vh" }}>
        <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={zoomOut} title="ズームアウト">－</button>
          <button onClick={fitViewHandler} title="全体を表示">全体</button>
          <button onClick={zoomIn} title="ズームイン">＋</button>
          <button onClick={exportImage}>画像として出力</button>
          <button onClick={exportMarkdown}>MD出力</button>
          <button onClick={triggerImport}>MD読み込み</button>
          <label htmlFor="export-filename" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#222' }}>出力ファイル名：</span>
            <input
              id="export-filename"
              aria-label="json-filename"
              value={exportFilename}
              onChange={(e) => {
                // prevent entering an extension or path separators; keep only the base name
                const cleaned = e.target.value.replace(/[\.\\/]/g, '');
                setExportFilename(cleaned);
              }}
              placeholder="ファイル名（拡張子不要）"
              style={{ width: 140, padding: '4px 6px', borderRadius: 6, border: '1px solid #ddd' }}
            />
          </label>
        </div>
  <input ref={fileInputRef} type="file" accept=".md,.markdown,application/json" style={{ display: 'none' }} onChange={handleFileChange} />

        <div ref={wrapperRef} style={{ width: "100%", height: "100%" }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={(instance) => (flowRef.current = instance)}
            fitView
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            zoomOnScroll={true}
            zoomOnPinch={true}
            zoomOnDoubleClick={false}
            panOnScroll={false}

            // ★ これ全部入れる
            nodesDraggable={false}
            nodesConnectable={false}

            /* ★これを追加 */
            selectNodesOnDrag={false}
            panOnDrag={true}

          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
      </div>
    </NodeActionContext.Provider>
  );
}

/* =====================
   レイアウト計算
===================== */
function layoutTree(
  nodes: Node<TextNodeData>[],
  nodeId: string,
  centerX: number,
  y: number
): Node<TextNodeData>[] {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return nodes;

  const children = nodes.filter((n) => n.data.parentId === nodeId);

  let updated = nodes.map((n) =>
    n.id === nodeId ? { ...n, position: { x: centerX, y } } : n
  );

  if (children.length === 0) return updated;

  const totalWidth =
    children.reduce(
      (sum, c) => sum + calcSubtreeWidth(updated, c.id),
      0
    ) +
    SUBTREE_GAP * (children.length - 1);

  let currentX = centerX - totalWidth / 2;

  for (const child of children) {
    const w = calcSubtreeWidth(updated, child.id);
    updated = layoutTree(
      updated,
      child.id,
      currentX + w / 2,
      y + GAP_Y
    );
    currentX += w + SUBTREE_GAP;
  }

  return updated;
}

function calcSubtreeWidth(
  nodes: Node<TextNodeData>[],
  nodeId: string
): number {
  const children = nodes.filter((n) => n.data.parentId === nodeId);
  if (children.length === 0) {
    const node = nodes.find((n) => n.id === nodeId);
    // use measured width if available, otherwise fall back to DEFAULT_NODE_WIDTH
    return (node && node.data.width) ? node.data.width : DEFAULT_NODE_WIDTH;
  }

  return (
    children.reduce((sum, c) => sum + calcSubtreeWidth(nodes, c.id), 0) +
    SUBTREE_GAP * (children.length - 1)
  );
}
