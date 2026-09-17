// Metro turns imported asset files into asset references (numbers).
declare module "*.ttf" {
  const asset: number;
  export default asset;
}

// @tabler/icons-react-native 3.46 maps its per-icon subpath types to
// dist/icons/*.d.ts, but ships them in dist/icons/icons/: declare them here.
declare module "@tabler/icons-react-native/*" {
  import type { Icon } from "@tabler/icons-react-native";
  const icon: Icon;
  export default icon;
}
