"use client";

// SWAP: hero scene. Replace with a film still or loop when Ram provides one; keep the scrim and grain.

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { luminanceOf, rgbOf, tokenValue } from "@/lib/theme/palette";
import type { Rgb } from "@/lib/theme/palette";
import { useThemeClass } from "@/lib/theme/use-theme-class";

export type SeaUniforms = { fade: number; rise: number; scroll: number };

const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2(-1.0, -1.0);
  if (gl_VertexID == 1) p = vec2(3.0, -1.0);
  if (gl_VertexID == 2) p = vec2(-1.0, 3.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// The geometry and motion are the same by night and by day. Only the colouring differs: at night
// the sun's light is added to a dark sea; by day the sea is an ink wash on paper, so the same
// glints darken the paper and the sun's path tints it red. u_light blends the two, and u_blend
// cross-fades from the palette before a theme change to the one after it.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time, u_fade, u_rise, u_scroll, u_mobile, u_blend, u_light_a, u_light_b;
uniform vec3 u_pa[7];
uniform vec3 u_pb[7];
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 canvas = mix(u_pa[0], u_pb[0], u_blend);
  vec3 skyTop = mix(u_pa[1], u_pb[1], u_blend);
  vec3 skyLow = mix(u_pa[2], u_pb[2], u_blend);
  vec3 seaNear = mix(u_pa[3], u_pb[3], u_blend);
  vec3 seaFar = mix(u_pa[4], u_pb[4], u_blend);
  vec3 glintColor = mix(u_pa[5], u_pb[5], u_blend);
  vec3 seal = mix(u_pa[6], u_pb[6], u_blend);
  float light = mix(u_light_a, u_light_b, u_blend);

  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float horizon = mix(0.42, 0.48, u_mobile);
  float hy = (horizon - 0.5) * 1.0;
  float aspect = u_res.x / u_res.y;
  float mx = (mix(0.68, 0.72, u_mobile) - 0.5) * aspect;
  float r = mix(0.070, 0.085, u_mobile);
  float my = hy + r * 0.35 - (1.0 - u_rise) * 0.12 - u_scroll * 0.16;
  vec2 m = vec2(mx, my);
  vec3 col;
  if (uv.y > horizon) {
    float t = (uv.y - horizon) / (1.0 - horizon);
    col = mix(skyLow, skyTop, pow(t, 0.45));
    float d = distance(p, m);
    float glow = exp(-d * d * 16.0);
    vec3 night = col + seal * 0.32 * glow;
    vec3 day = mix(col, seal, 0.30 * glow);
    col = mix(night, day, light);
    float disk = smoothstep(r + 0.0025, r - 0.0025, d);
    vec2 n = (p - m) / r;
    float shade = clamp(dot(n, vec2(0.55, -0.55)) * 0.5 + 0.5, 0.0, 1.0);
    vec3 lit = mix(seal * mix(1.18, 1.06, light), seal * mix(0.72, 0.84, light), shade);
    col = mix(col, lit, disk);
  } else {
    float depth = (horizon - uv.y) / horizon;
    col = mix(seaNear, seaFar, pow(depth, 0.6));
    float z = 1.0 / (depth + 0.025);
    float wx = p.x * z;
    float w = sin(wx * 6.0 + z * 1.2 - u_time * 0.6) * 0.5
            + sin(wx * 13.0 - z * 2.1 + u_time * 0.9) * 0.25
            + sin(wx * 27.0 + z * 3.7 - u_time * 1.4) * 0.12;
    float glint = pow(max(0.0, w), 6.0);
    float width = r * 0.95 * (1.0 + depth * 2.2);
    float path = exp(-pow((p.x - m.x) / width, 2.0));
    float sunk = clamp(1.0 - u_scroll * 1.4, 0.0, 1.0);
    vec2 sc = vec2(wx * 70.0, z * 14.0);
    float spark = step(0.988, hash(floor(sc) + floor(u_time * 3.0)));
    spark *= smoothstep(0.32, 0.0, length(fract(sc) - 0.5)) * (1.0 - depth) * (1.0 - depth);
    float lit = u_rise * sunk;
    vec3 night = col;
    night += seal * 1.4 * glint * path * (1.0 - depth * 0.55) * lit;
    night += seal * 0.9 * spark * path * (1.0 - depth) * lit;
    night += glintColor * glint * 0.07 * (1.0 - depth);
    night += seal * 0.10 * path * (1.0 - depth * 0.7) * lit;
    vec3 day = mix(col, glintColor, glint * 0.5 * (1.0 - depth * 0.45));
    day = mix(day, seal, clamp(0.55 * glint * path * (1.0 - depth * 0.55) * lit + 0.10 * path * (1.0 - depth * 0.7) * lit, 0.0, 1.0));
    day = mix(day, seal, 0.6 * spark * path * (1.0 - depth) * lit);
    col = mix(night, day, light);
  }
  col = mix(col, skyLow, exp(-abs(uv.y - horizon) * 60.0) * 0.45);
  col *= 1.0 - mix(0.35, 0.10, light) * length(uv - 0.5);
  col = mix(col * u_fade, mix(canvas, col, u_fade), light);
  outColor = vec4(col, 1.0);
}`;

const FALLBACK_BACKGROUND = [
  "radial-gradient(circle at 68% 50%, color-mix(in srgb, var(--seal) 90%, transparent) 0 6vh, color-mix(in srgb, var(--seal) 25%, transparent) 6.2vh, transparent 22vh)",
  "linear-gradient(to bottom, var(--scene-sky-top) 0%, var(--scene-sky-low) 58%, var(--scene-sea-far) 58.2%, var(--scene-sea-near) 100%)",
].join(", ");

const DESKTOP_MIN_WIDTH = 768;
const STILL_FRAME_SECONDS = 12;
const THEME_FADE_MS = 400;

const PALETTE_TOKENS = ["--canvas", "--scene-sky-top", "--scene-sky-low", "--scene-sea-near", "--scene-sea-far", "--scene-glint", "--seal"];

type Palette = { colors: Float32Array; light: number };

function readPalette(): Palette {
  const rgb = PALETTE_TOKENS.map((token) => rgbOf(tokenValue(token)));
  return { colors: new Float32Array(rgb.flat()), light: luminanceOf(rgb[0] as Rgb) > 0.5 ? 1 : 0 };
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export function NightSea({ uniforms }: { uniforms: RefObject<SeaUniforms> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);
  const themeClass = useThemeClass();
  // The scene's own handle on the theme: a function the render effect installs, called by the
  // theme effect below, so a theme change never rebuilds the WebGL program.
  const retheme = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
    });
    const program = gl ? link(gl) : null;
    if (!gl || !program) {
      setFallback(true);
      return;
    }

    const location = (name: string) => gl.getUniformLocation(program, name);
    const uRes = location("u_res");
    const uTime = location("u_time");
    const uFade = location("u_fade");
    const uRise = location("u_rise");
    const uScroll = location("u_scroll");
    const uMobile = location("u_mobile");
    const uBlend = location("u_blend");
    const uLightA = location("u_light_a");
    const uLightB = location("u_light_b");
    const uPaletteA = location("u_pa");
    const uPaletteB = location("u_pb");

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const startedAt = performance.now();
    let mobile = 0;
    let from = readPalette();
    let to = from;
    let blendStartedAt = -Infinity;

    const draw = () => {
      const now = performance.now();
      // Ease-out over 400ms from the old palette to the new one; instant under reduced motion.
      const raw = reduceMotion ? 1 : Math.min(1, (now - blendStartedAt) / THEME_FADE_MS);
      const blend = 1 - (1 - raw) ** 3;
      gl.useProgram(program);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uMobile, mobile);
      gl.uniform3fv(uPaletteA, from.colors);
      gl.uniform3fv(uPaletteB, to.colors);
      gl.uniform1f(uLightA, from.light);
      gl.uniform1f(uLightB, to.light);
      gl.uniform1f(uBlend, blend);
      if (reduceMotion) {
        gl.uniform1f(uTime, STILL_FRAME_SECONDS);
        gl.uniform1f(uFade, 1);
        gl.uniform1f(uRise, 1);
        gl.uniform1f(uScroll, 0);
      } else {
        const current = uniforms.current;
        gl.uniform1f(uTime, (now - startedAt) / 1000);
        gl.uniform1f(uFade, current.fade);
        gl.uniform1f(uRise, current.rise);
        gl.uniform1f(uScroll, current.scroll);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    retheme.current = () => {
      from = to;
      to = readPalette();
      blendStartedAt = performance.now();
      if (reduceMotion) draw();
    };

    const resize = () => {
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      const wide = width >= DESKTOP_MIN_WIDTH;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      mobile = wide ? 0 : 1;
      gl.viewport(0, 0, canvas.width, canvas.height);
      // Resizing clears the buffer, and a still frame has no loop to refill it.
      if (reduceMotion) draw();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(parent);
    resize();

    if (reduceMotion) {
      return () => {
        retheme.current = null;
        resizeObserver.disconnect();
        gl.deleteProgram(program);
      };
    }

    let frameId = 0;
    let onScreen = true;

    const frame = () => {
      draw();
      frameId = requestAnimationFrame(frame);
    };
    const syncLoop = () => {
      const wanted = onScreen && !document.hidden;
      if (wanted && frameId === 0) frameId = requestAnimationFrame(frame);
      if (!wanted && frameId !== 0) {
        cancelAnimationFrame(frameId);
        frameId = 0;
      }
    };

    const visibility = new IntersectionObserver(
      (entries) => {
        onScreen = entries[entries.length - 1]?.isIntersecting ?? true;
        syncLoop();
      },
      { threshold: 0 },
    );
    visibility.observe(canvas);
    document.addEventListener("visibilitychange", syncLoop);
    syncLoop();

    return () => {
      retheme.current = null;
      cancelAnimationFrame(frameId);
      visibility.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", syncLoop);
      gl.deleteProgram(program);
    };
  }, [uniforms]);

  // Keyed on the class itself, which changes after the provider's state does: when this runs the
  // tokens already read the new theme. Keyed on useTheme they read the old one (F1b).
  useEffect(() => {
    retheme.current?.();
  }, [themeClass]);

  if (fallback) {
    return (
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{ background: FALLBACK_BACKGROUND }}
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 block h-full w-full"
    />
  );
}
