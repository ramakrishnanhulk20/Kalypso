"use client";

// SWAP: hero scene. Replace with a film still or loop when Ram provides one; keep the scrim and grain.

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export type SeaUniforms = { fade: number; rise: number; scroll: number };

const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2(-1.0, -1.0);
  if (gl_VertexID == 1) p = vec2(3.0, -1.0);
  if (gl_VertexID == 2) p = vec2(-1.0, 3.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time, u_fade, u_rise, u_scroll, u_mobile;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float horizon = mix(0.42, 0.48, u_mobile);
  float hy = (horizon - 0.5) * 1.0;
  vec3 ink = vec3(0.082, 0.063, 0.059);
  vec3 skyTop = vec3(0.060, 0.045, 0.045);
  vec3 skyLow = vec3(0.200, 0.092, 0.080);
  vec3 seal = vec3(0.788, 0.278, 0.227);
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
    col += seal * 0.32 * exp(-d * d * 16.0);
    float disk = smoothstep(r + 0.0025, r - 0.0025, d);
    vec2 n = (p - m) / r;
    vec3 lit = mix(seal * 1.18, seal * 0.72, clamp(dot(n, vec2(0.55, -0.55)) * 0.5 + 0.5, 0.0, 1.0));
    col = mix(col, lit, disk);
  } else {
    float depth = (horizon - uv.y) / horizon;
    col = mix(vec3(0.105, 0.062, 0.055), ink * 0.72, pow(depth, 0.6));
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
    col += seal * 1.4 * glint * path * (1.0 - depth * 0.55) * u_rise * sunk;
    col += seal * 0.9 * spark * path * (1.0 - depth) * u_rise * sunk;
    col += vec3(0.25, 0.20, 0.19) * glint * 0.07 * (1.0 - depth);
    col += seal * 0.10 * path * (1.0 - depth * 0.7) * u_rise * sunk;
  }
  col = mix(col, skyLow, exp(-abs(uv.y - horizon) * 60.0) * 0.45);
  col *= 1.0 - 0.35 * length(uv - 0.5);
  col *= u_fade;
  outColor = vec4(col, 1.0);
}`;

const FALLBACK_BACKGROUND = [
  "radial-gradient(circle at 68% 50%, rgba(201,71,58,0.9) 0 6vh, rgba(201,71,58,0.25) 6.2vh, rgba(201,71,58,0) 22vh)",
  "linear-gradient(to bottom, #120d0d 0%, #2a1715 58%, #0d0a0a 58.2%, #120d0d 100%)",
].join(", ");

const DESKTOP_MIN_WIDTH = 768;
const STILL_FRAME_SECONDS = 12;

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

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const startedAt = performance.now();
    let mobile = 0;

    const draw = () => {
      gl.useProgram(program);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uMobile, mobile);
      if (reduceMotion) {
        gl.uniform1f(uTime, STILL_FRAME_SECONDS);
        gl.uniform1f(uFade, 1);
        gl.uniform1f(uRise, 1);
        gl.uniform1f(uScroll, 0);
      } else {
        const current = uniforms.current;
        gl.uniform1f(uTime, (performance.now() - startedAt) / 1000);
        gl.uniform1f(uFade, current.fade);
        gl.uniform1f(uRise, current.rise);
        gl.uniform1f(uScroll, current.scroll);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
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
      cancelAnimationFrame(frameId);
      visibility.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", syncLoop);
      gl.deleteProgram(program);
    };
  }, [uniforms]);

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
