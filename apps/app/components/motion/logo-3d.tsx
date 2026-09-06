"use client";

/**
 * The mark, as a slowly turning slab.
 *
 * The reference's own hero object: a box whose two faces carry the logo texture
 * and whose four edges are solid, lit from two sides and turned at a constant
 * rate. It is the one piece of decoration on the page and it earns its place by
 * being the thing a reader looks at while the words underneath load.
 *
 * Three things keep it honest. It never spins under a reduced-motion preference,
 * because a rotating object is exactly what that preference is about. The canvas
 * is deferred until the element is near the viewport, so a reader who never
 * scrolls to it never downloads a renderer. And a device with no WebGL gets the
 * flat mark instead of an empty box, which is a worse picture and a working page.
 */

import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { Environment, Lightformer, OrbitControls } from "@react-three/drei";
import { MeshStandardMaterial, TextureLoader } from "three";
import type { Mesh } from "three";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "../ui/cn";

function LogoSlab({ spin }: { readonly spin: boolean }) {
  const mesh = useRef<Mesh>(null);
  const texture = useLoader(TextureLoader, "/logo.png");

  const edge = new MeshStandardMaterial({ color: "#05100f", metalness: 0.35, roughness: 0.4 });
  const face = new MeshStandardMaterial({ map: texture, metalness: 0.2, roughness: 0.5 });
  const materials = [edge, edge, edge, edge, face, face];

  useFrame((_, delta) => {
    if (spin && mesh.current) mesh.current.rotation.y += delta * 0.3;
  });

  return (
    <mesh ref={mesh} castShadow receiveShadow material={materials}>
      <boxGeometry args={[4, 4, 0.5]} />
    </mesh>
  );
}

/** True once the element has been within a screen of the viewport. Never resets. */
function useNearViewport<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, near };
}

export interface Logo3DProps {
  readonly className?: string;
  readonly delay?: number;
  readonly duration?: number;
}

export function Logo3D({ className, delay = 0, duration = 1.2 }: Logo3DProps) {
  const reduced = useReducedMotion() === true;
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const [failed, setFailed] = useState(false);

  return (
    <div ref={ref} className={cn("relative h-full w-full overflow-hidden rounded-lg", className)}>
      <motion.div
        className="absolute inset-0 rounded-lg border border-border/60 bg-muted/30"
        initial={{ scaleY: 0 }}
        animate={{ scaleY: 1 }}
        transition={{ duration: reduced ? 0 : 0.4, ease: "easeOut", delay: reduced ? 0 : delay }}
        style={{ transformOrigin: "center" }}
      />
      <motion.div
        className="absolute inset-0 h-full w-full"
        initial={{ opacity: 0, filter: "blur(16px) saturate(0.9)" }}
        animate={{ opacity: 1, filter: "blur(0px) saturate(1)" }}
        transition={{
          duration: reduced ? 0 : duration,
          delay: reduced ? 0 : delay + 0.4,
          ease: "easeOut",
        }}
      >
        {near && !failed ? (
          <Canvas
            camera={{ position: [0, 0, 8], fov: 50 }}
            gl={{ antialias: true }}
            onCreated={({ gl }) => {
              gl.domElement.addEventListener("webglcontextlost", () => setFailed(true), {
                once: true,
              });
            }}
            fallback={<FlatMark />}
          >
            <ambientLight intensity={0.8} />
            <directionalLight position={[10, 10, 5]} intensity={1.2} />
            <directionalLight position={[-10, -10, -5]} intensity={0.6} />
            <Suspense fallback={null}>
              <LogoSlab spin={!reduced} />
              {/*
                The environment is built here rather than named.

                `preset="studio"` looks like a local constant and is not: drei
                resolves a preset by downloading an HDRI from a pinned commit on
                raw.githubusercontent.com, on every load, for every canvas. It
                took 1.4s on a fast connection, it is a third party in the
                critical path of the first thing on the page, and where GitHub is
                slow or unreachable the mark never arrives at all.

                Three lightformers give the slab the same soft key, rim and fill
                a studio preset does, render in-process, and fetch nothing.
              */}
              <Environment resolution={128}>
                <Lightformer intensity={2.2} position={[0, 3, 4]} scale={[8, 4, 1]} color="#ffffff" />
                <Lightformer intensity={1.1} position={[-4, 1, 2]} scale={[4, 6, 1]} color="#cfe8e6" />
                <Lightformer intensity={0.8} position={[4, -1, 1]} scale={[4, 4, 1]} color="#9fb6bd" />
              </Environment>
            </Suspense>
            <OrbitControls enableZoom enablePan={false} minDistance={5} maxDistance={15} />
          </Canvas>
        ) : (
          <FlatMark />
        )}
      </motion.div>
    </div>
  );
}

/** What a reader sees with no WebGL: the mark, still, and no empty rectangle. */
function FlatMark() {
  return (
    <div className="flex h-full w-full items-center justify-center p-10">
      <img src="/logo.png" alt="" className="max-h-full max-w-full object-contain opacity-90" />
    </div>
  );
}
