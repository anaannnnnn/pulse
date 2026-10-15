import { useEffect, useRef } from 'react';
import { lowPower } from '../motion/gsap';

/* A slow, living colour field rendered with three.js (one fullscreen shader plane, no meshes, no textures).
   - three is imported on demand, so it never touches the first paint or the main bundle.
   - renders at ~half resolution and 30fps, pauses when off-screen or the tab is hidden.
   - skipped entirely on low-power devices / reduced motion; the CSS aurora underneath stays as the fallback.
   - colours follow the ambient hue (see motion/ambient.ts). */
const FRAG = `
precision mediump float;
uniform float t; uniform vec2 r; uniform vec3 c1; uniform vec3 c2; uniform vec3 c3; uniform float k;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<4;i++){ s+=a*n(p); p=p*2.03+7.1; a*=.5; } return s; }
void main(){
  vec2 uv = gl_FragCoord.xy / r.xy;
  vec2 p = vec2(uv.x * r.x / r.y, uv.y) * 1.7;
  float a = fbm(p + vec2(t*.045, -t*.03));
  float b = fbm(p*1.6 - a*1.4 + vec2(-t*.03, t*.05));
  vec3 col = mix(c1, c2, smoothstep(.25, .8, a));
  col = mix(col, c3, smoothstep(.45, .95, b) * .85);
  float rib = smoothstep(.0, .6, abs(sin((p.y + a*1.8) * 3.2 + t*.12)));
  col *= .28 + .9 * b * (.6 + .4 * rib);
  float v = smoothstep(1.25, .15, length(uv - vec2(.5, .62)));
  gl_FragColor = vec4(col * v * k, 1.0);
}`;

const hsl = (h: number, s: number, l: number): [number, number, number] => {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l), f = (n: number) => l - a * Math.max(-1, Math.min((n + h / 30) % 12 - 3, Math.min(9 - ((n + h / 30) % 12), 1)));
  return [f(0), f(8), f(4)];
};

export function AuroraCanvas({ className = '', intensity = 1, scale = 0.5 }: { className?: string; intensity?: number; scale?: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || lowPower()) return;
    let dispose = () => {};
    let dead = false;
    (async () => {
      let THREE: typeof import('three');
      try {
        THREE = await import('three');
      } catch {
        return;
      }
      if (dead) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power' });
      } catch {
        return; // no WebGL: CSS aurora remains
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale;
      renderer.setPixelRatio(dpr);
      el.appendChild(renderer.domElement);
      renderer.domElement.setAttribute('aria-hidden', 'true');
      Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
      const scene = new THREE.Scene();
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const cur = getComputedStyle(document.documentElement);
      const base = parseFloat(cur.getPropertyValue('--amb-h')) || 270;
      const u = {
        t: { value: Math.random() * 50 }, r: { value: new THREE.Vector2(1, 1) }, k: { value: intensity },
        c1: { value: new THREE.Vector3(...hsl(base, 70, 18)) }, c2: { value: new THREE.Vector3(...hsl(base + 40, 80, 40)) }, c3: { value: new THREE.Vector3(...hsl(base - 50, 85, 55)) },
      };
      const mat = new THREE.ShaderMaterial({ uniforms: u, fragmentShader: FRAG, vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0., 1.); }', depthTest: false, depthWrite: false });
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      const size = () => {
        const w = el.clientWidth || 1, h = el.clientHeight || 1;
        renderer.setSize(w, h, false);
        u.r.value.set(w * dpr, h * dpr);
      };
      size();
      const ro = new ResizeObserver(size);
      ro.observe(el);
      const onAmb = (e: Event) => {
        const { h } = (e as CustomEvent).detail as { h: number };
        u.c1.value.set(...hsl(h, 70, 18));
        u.c2.value.set(...hsl(h + 40, 80, 40));
        u.c3.value.set(...hsl(h - 50, 85, 55));
      };
      window.addEventListener('pulse-ambient', onAmb);
      let vis = true, tab = !document.hidden, raf = 0, last = 0;
      const io = new IntersectionObserver((es) => { vis = es[0]?.isIntersecting ?? true; });
      io.observe(el);
      const onVis = () => { tab = !document.hidden; };
      document.addEventListener('visibilitychange', onVis);
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        if (!vis || !tab || now - last < 33) return;
        u.t.value += (now - last) / 1000 * (last ? 1 : 0);
        last = now;
        renderer.render(scene, cam);
      };
      raf = requestAnimationFrame(loop);
      const lost = (e: Event) => { e.preventDefault(); cancelAnimationFrame(raf); };
      renderer.domElement.addEventListener('webglcontextlost', lost);
      requestAnimationFrame(() => el.classList.add('live'));
      dispose = () => {
        cancelAnimationFrame(raf);
        ro.disconnect(); io.disconnect();
        window.removeEventListener('pulse-ambient', onAmb);
        document.removeEventListener('visibilitychange', onVis);
        renderer.domElement.removeEventListener('webglcontextlost', lost);
        mat.dispose(); renderer.dispose();
        renderer.domElement.remove();
        el.classList.remove('live');
      };
    })();
    return () => { dead = true; dispose(); };
  }, [intensity, scale]);
  return <div ref={host} className={`aurora-canvas ${className}`} aria-hidden="true" />;
}
