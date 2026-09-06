"use client";

/**
 * The attested chain, as a strip of blocks with the proven one lit.
 *
 * This is the only place on the site where 3D earns its cost, because it is the
 * only place where the thing being shown is genuinely spatial: a run of Source
 * Chain blocks, one of which carries the transaction this page is about, and all
 * of which sit under a Creditcoin attestation that covers them.
 *
 * What it must not do is decorate a number. Every figure on this page is in the
 * table beside it, in text, and this adds no data of its own: it shows where one
 * block sits among its neighbours and nothing else. A reader who cannot see it
 * loses nothing, which is why the whole thing is `aria-hidden` and the heights
 * carry no meaning.
 *
 * It is skipped under a reduced-motion preference and on a device with no WebGL,
 * and it is not loaded at all until it is near the viewport.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { useReducedMotion } from "motion/react";
import type { Mesh } from "three";

import { cn } from "../ui/cn";

const BLOCKS = 15;
const PROVEN_INDEX = 7;

function Block({
  index,
  proven,
  animate,
}: {
  readonly index: number;
  readonly proven: boolean;
  readonly animate: boolean;
}) {
  const mesh = useRef<Mesh>(null);
  const x = (index - (BLOCKS - 1) / 2) * 1.05;
  // Heights vary so the strip reads as a run of blocks rather than a bar chart,
  // and they are derived from the index rather than random so the picture is the
  // same on every render and in every screenshot.
  const height = 0.55 + ((index * 37) % 11) / 22;

  useFrame((state) => {
    if (!animate || mesh.current === null) return;
    const t = state.clock.elapsedTime;
    mesh.current.position.y = proven ? Math.sin(t * 1.4) * 0.06 : Math.sin(t * 0.6 + index) * 0.02;
  });

  return (
    <mesh ref={mesh} position={[x, 0, 0]} castShadow receiveShadow>
      <boxGeometry args={[0.7, height, 0.7]} />
      <meshStandardMaterial
        color={proven ? "#0f9e8e" : "#7c8a99"}
        emissive={proven ? "#0d7f74" : "#000000"}
        emissiveIntensity={proven ? 0.85 : 0}
        metalness={proven ? 0.3 : 0.15}
        roughness={proven ? 0.25 : 0.65}
      />
    </mesh>
  );
}

function Strip({ animate }: { readonly animate: boolean }) {
  const blocks = useMemo(() => Array.from({ length: BLOCKS }, (_, index) => index), []);
  return (
    <group rotation={[0.32, -0.42, 0]}>
      {blocks.map((index) => (
        <Block key={index} index={index} proven={index === PROVEN_INDEX} animate={animate} />
      ))}
    </group>
  );
}

export interface AttestationStripProps {
  readonly blockHeight: string;
  readonly className?: string;
}

export function AttestationStrip({ blockHeight, className }: AttestationStripProps) {
  const reduced = useReducedMotion() === true;
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [failed, setFailed] = useState(false);

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
      { rootMargin: "50% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn(
        // `h-full` with a column layout so the canvas takes whatever height the
        // grid row has. Beside a tall proof card this panel used to stop at 220px
        // and leave a third of the row empty, which read as a missing block
        // rather than as a deliberately short one.
        "relative flex h-full flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/30",
        className,
      )}
    >
      <div aria-hidden="true" className="min-h-[220px] w-full flex-1">
        {near && !failed ? (
          <Canvas
            camera={{ position: [0, 2.6, 9], fov: 42 }}
            gl={{ antialias: true }}
            onCreated={({ gl }) => {
              gl.domElement.addEventListener("webglcontextlost", () => setFailed(true), {
                once: true,
              });
            }}
          >
            <ambientLight intensity={0.55} />
            <directionalLight position={[6, 8, 6]} intensity={1.1} />
            <pointLight position={[0, 1.6, 2.4]} intensity={12} color="#14b8a6" distance={9} />
            <Suspense fallback={null}>
              <Strip animate={!reduced} />
              {/*
                Built rather than named, for the same reason as the hero mark: a
                drei preset downloads an HDRI from raw.githubusercontent.com on
                every load, which puts a third party in the critical path of a
                decorative reflection.
              */}
              <Environment resolution={128}>
                <Lightformer intensity={1.6} position={[0, 4, 3]} scale={[10, 3, 1]} color="#ffffff" />
                <Lightformer intensity={0.9} position={[-5, 0, 2]} scale={[4, 5, 1]} color="#b9c9cf" />
              </Environment>
            </Suspense>
            <EffectComposer>
              <Bloom intensity={0.45} luminanceThreshold={0.55} luminanceSmoothing={0.4} mipmapBlur />
            </EffectComposer>
          </Canvas>
        ) : null}
      </div>

      <p className="border-t border-border px-5 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        Block {blockHeight} on the Source Chain, lit among its neighbours. The picture carries no
        figure of its own: every number on this page is in the table above it.
      </p>
    </div>
  );
}
