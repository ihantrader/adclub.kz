import { radius } from "@adclub/ui-core";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, EmptyState, Text, useTheme } from "../design-system";
import { useT } from "../state/language";

/** A photo the camera took: a file the app made, to be deleted once read. */
export interface CameraShot {
  uri: string;
  width: number;
  height: number;
}

/**
 * The camera of a screen that reads a photo (TASK-058: the dashboard and a
 * part; the certificate keeps its own, TASK-057): the permission asked once
 * when the screen opens, a camera that failed to start counted as none, and
 * the shot. Where there is no camera — a browser, a denied permission — the
 * screen offers the gallery instead.
 */
export function useCamera(active: boolean) {
  const [permission, requestPermission] = useCameraPermissions();
  const [broken, setBroken] = useState(false);
  const [ready, setReady] = useState(false);
  const ref = useRef<CameraView>(null);
  const usable = permission?.granted === true && !broken;
  const denied =
    permission !== null && (broken || (!permission.granted && !permission.canAskAgain));

  // The system asks for the camera when the screen that needs it opens.
  const asked = useRef(false);
  useEffect(() => {
    if (!active || asked.current || !permission || permission.granted || !permission.canAskAgain) {
      return;
    }
    asked.current = true;
    void requestPermission();
  }, [active, permission, requestPermission]);

  const shoot = async (): Promise<CameraShot | null> => {
    if (!ref.current) return null;
    try {
      const photo = await ref.current.takePictureAsync({ quality: 0.9, exif: false });
      return photo ? { uri: photo.uri, width: photo.width, height: photo.height } : null;
    } catch {
      setBroken(true);
      return null;
    }
  };

  return {
    cameraRef: ref,
    camera: {
      usable,
      denied,
      ready,
      canAskAgain: permission?.canAskAgain === true && !broken,
      requestPermission,
      shoot,
      onReady: () => setReady(true),
      onBroken: () => setBroken(true),
    },
  };
}

/** The state of the camera, without its ref (read while rendering). */
export type Camera = ReturnType<typeof useCamera>["camera"];

/**
 * The camera with a frame and a hint over it; without a camera — «Нет
 * доступа к камере» and «Разрешить камеру» while the system may still ask.
 * `frame` — the shape of what is photographed: a wide dashboard, a label.
 */
export function CameraPanel({
  camera,
  cameraRef,
  hint,
  frame,
}: {
  camera: Camera;
  cameraRef: ReturnType<typeof useCamera>["cameraRef"];
  hint: string;
  frame: "wide" | "label";
}) {
  const t = useT();
  const { theme } = useTheme();
  if (camera.usable) {
    return (
      <View style={[styles.camera, { backgroundColor: theme.colors.fill }]}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          onCameraReady={camera.onReady}
          onMountError={camera.onBroken}
        />
        <View pointerEvents="none" style={styles.overlay}>
          <View style={[styles.frame, frame === "wide" ? styles.wide : styles.label]} />
          <Text variant="bodyS" style={styles.hint}>
            {hint}
          </Text>
        </View>
      </View>
    );
  }
  if (camera.denied) {
    return (
      <EmptyState
        icon="cameraSlash"
        title={t("doc.cameraDeniedTitle")}
        text={t("doc.cameraDeniedText")}
        action={
          camera.canAskAgain ? (
            <Button variant="secondary" size="m" onPress={() => void camera.requestPermission()}>
              {t("doc.cameraAllow")}
            </Button>
          ) : undefined
        }
      />
    );
  }
  // Still asking: a place for the camera, and the hint for the gallery.
  return (
    <View style={[styles.camera, styles.waiting, { backgroundColor: theme.colors.fill }]}>
      <Text variant="bodyS" color="textMuted" style={styles.center}>
        {hint}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  camera: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: radius.m,
    overflow: "hidden",
  },
  waiting: { alignItems: "center", justifyContent: "center", padding: 24 },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 16,
  },
  frame: { borderWidth: 2, borderColor: "#FFFFFF", borderRadius: radius.m },
  wide: { width: "92%", aspectRatio: 16 / 9 },
  label: { width: "80%", aspectRatio: 3 / 2 },
  hint: {
    color: "#FFFFFF",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },
  center: { textAlign: "center" },
});
