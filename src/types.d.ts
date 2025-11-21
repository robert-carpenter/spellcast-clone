declare module "*.txt?raw" {
  const content: string;
  export default content;
}

declare module "*.m4a" {
  const src: string;
  export default src;
}
