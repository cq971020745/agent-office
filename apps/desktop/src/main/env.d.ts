// electron-vite 的 ?asset 导入：构建期把资源复制进 out，导入值为运行时可用的文件绝对路径
declare module "*.png?asset" {
  const src: string;
  export default src;
}
