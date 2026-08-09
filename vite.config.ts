import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const publicEnv = {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("NEXT_PUBLIC_"))),
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("NEXT_PUBLIC_"))),
  };
  const publicEnvDefines = Object.fromEntries(
    Object.entries(publicEnv).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
  );

  return {
    plugins: [react()],
    build: {
      outDir: "pages-dist",
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
    define: {
      "process.env": JSON.stringify(publicEnv),
      ...publicEnvDefines,
    },
  };
});
