"use client";

import { STORAGE_KEYS } from "@/lib/constants";
import { createRoomCode } from "@/lib/id";
import type { Player, Room } from "@/types/game";

function readRooms(): Record<string, Room> {
  const raw = localStorage.getItem(STORAGE_KEYS.rooms);

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, Room>;
  } catch {
    localStorage.removeItem(STORAGE_KEYS.rooms);
    return {};
  }
}

function writeRooms(rooms: Record<string, Room>) {
  localStorage.setItem(STORAGE_KEYS.rooms, JSON.stringify(rooms));
}

function makePlayer(playerId: string, nickname: string, isHost: boolean): Player {
  return {
    id: playerId,
    nickname,
    isHost,
    role: "PLAYER",
    joinedAt: Date.now(),
  };
}

function upsertPlayer(room: Room, player: Player): Room {
  const existingIndex = room.players.findIndex((item) => item.id === player.id);

  if (existingIndex >= 0) {
    const players = [...room.players];
    players[existingIndex] = {
      ...players[existingIndex],
      nickname: player.nickname,
      isHost: player.isHost,
    };

    return {
      ...room,
      players,
    };
  }

  return {
    ...room,
    players: [...room.players, player],
  };
}

export function createMockRoom(playerId: string, nickname: string) {
  const rooms = readRooms();
  let code = createRoomCode();

  while (rooms[code]) {
    code = createRoomCode();
  }

  const room: Room = {
    code,
    hostPlayerId: playerId,
    players: [makePlayer(playerId, nickname, true)],
    status: "LOBBY",
    createdAt: Date.now(),
  };

  rooms[code] = room;
  writeRooms(rooms);

  return room;
}

export function joinMockRoom(code: string, playerId: string, nickname: string) {
  const rooms = readRooms();
  const normalizedCode = code.trim();
  const existingRoom = rooms[normalizedCode];

  if (!existingRoom) {
    return null;
  }

  const isHost = existingRoom.hostPlayerId === playerId;
  const updatedRoom = upsertPlayer(existingRoom, makePlayer(playerId, nickname, isHost));
  rooms[normalizedCode] = updatedRoom;
  writeRooms(rooms);

  return updatedRoom;
}

export function getMockRoom(code: string) {
  const rooms = readRooms();
  return rooms[code] ?? null;
}

export function hasPlayerInMockRoom(code: string, playerId: string) {
  const room = getMockRoom(code);
  return Boolean(room?.players.some((player) => player.id === playerId));
}

export function ensurePlayerInMockRoom(code: string, playerId: string, nickname: string) {
  const rooms = readRooms();
  const room = rooms[code];

  if (!room) {
    return null;
  }

  const isHost = room.hostPlayerId === playerId;
  const updatedRoom = upsertPlayer(room, makePlayer(playerId, nickname, isHost));
  rooms[code] = updatedRoom;
  writeRooms(rooms);

  return updatedRoom;
}
