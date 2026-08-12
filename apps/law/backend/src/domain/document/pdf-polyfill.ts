/**
 * DOMMatrix for pdfjs on bare Node (side-effect module — import it
 * BEFORE pdfjs).
 *
 * pdfjs's legacy build constructs a module-scope `new DOMMatrix()` at
 * LOAD time, and polyfills the global from `@napi-rs/canvas` — a
 * native module the production image deliberately does not carry (the
 * image is the esbuild bundle, no node_modules; Dockerfile). Without
 * this shim the container dies at boot with `DOMMatrix is not
 * defined` — found by CI's image boot check, invisible to every
 * source-level test because the dev tree HAS the canvas package.
 *
 * Installed with `??=`, which on bare Node (no DOMMatrix anywhere)
 * means pdfjs finds it already defined and skips its canvas lookup —
 * dev and image run the SAME code path, so the extraction integration
 * suite exercises exactly what production runs.
 *
 * The shim is a correct 2D affine matrix, not a stub of nothings:
 * text extraction never renders (every DOMMatrix call site in pdfjs
 * is canvas/path work), but if a future path strays in, the math is
 * right rather than silently wrong. Rendering (getViewport canvas
 * work, Path2D) is NOT supported and not needed — pdfjs's own
 * module-load warning about Path2D is expected and harmless.
 */

type Six = [number, number, number, number, number, number];

class NodeDOMMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;

  constructor(init?: number[] | NodeDOMMatrix) {
    const [a, b, c, d, e, f]: Six =
      init === undefined
        ? [1, 0, 0, 1, 0, 0]
        : Array.isArray(init)
          ? ([...init] as Six)
          : [init.a, init.b, init.c, init.d, init.e, init.f];
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
  }

  /** this = other × this (DOMMatrix semantics). */
  preMultiplySelf(other: NodeDOMMatrix): this {
    return this.#set(multiply(other, this));
  }

  /** this = this × other. */
  multiplySelf(other: NodeDOMMatrix): this {
    return this.#set(multiply(this, other));
  }

  translate(tx = 0, ty = 0): NodeDOMMatrix {
    return multiply(this, new NodeDOMMatrix([1, 0, 0, 1, tx, ty]));
  }

  scale(sx = 1, sy = sx): NodeDOMMatrix {
    return multiply(this, new NodeDOMMatrix([sx, 0, 0, sy, 0, 0]));
  }

  #set(m: NodeDOMMatrix): this {
    this.a = m.a;
    this.b = m.b;
    this.c = m.c;
    this.d = m.d;
    this.e = m.e;
    this.f = m.f;
    return this;
  }
}

function multiply(m1: NodeDOMMatrix, m2: NodeDOMMatrix): NodeDOMMatrix {
  return new NodeDOMMatrix([
    m1.a * m2.a + m1.c * m2.b,
    m1.b * m2.a + m1.d * m2.b,
    m1.a * m2.c + m1.c * m2.d,
    m1.b * m2.c + m1.d * m2.d,
    m1.a * m2.e + m1.c * m2.f + m1.e,
    m1.b * m2.e + m1.d * m2.f + m1.f,
  ]);
}

(globalThis as { DOMMatrix?: unknown }).DOMMatrix ??= NodeDOMMatrix;
