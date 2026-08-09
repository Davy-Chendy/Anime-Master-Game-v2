import { useEffect, useState } from "react";
import HomePage from "@/app/page";
import RoomPage from "@/app/room/[roomCode]/page";
import PublicRoomsPage from "@/app/public-rooms/page";

function currentPath() {
  return window.location.pathname;
}

export default function App() {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    function handleRouteChange() {
      setPath(currentPath());
    }

    window.addEventListener("popstate", handleRouteChange);
    window.addEventListener("app-route-change", handleRouteChange);
    handleRouteChange();

    return () => {
      window.removeEventListener("popstate", handleRouteChange);
      window.removeEventListener("app-route-change", handleRouteChange);
    };
  }, []);

  const roomMatch = path.match(/^\/room\/([^/]+)/);

  if (roomMatch) {
    return <RoomPage initialRoomCode={decodeURIComponent(roomMatch[1])} />;
  }

  if (path === "/public-rooms") return <PublicRoomsPage />;

  return <HomePage />;
}
