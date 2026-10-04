// Metro turns imported asset files into asset references (numbers).
declare module "*.ttf" {
  const asset: number;
  export default asset;
}
