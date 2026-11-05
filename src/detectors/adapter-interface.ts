import { ProjectInfo } from '../types';

export interface BuildAdapter {
  name: string;
  detect(projectRoot: string): Promise<boolean>;
  inspect(projectRoot: string): Promise<ProjectInfo>;
}
