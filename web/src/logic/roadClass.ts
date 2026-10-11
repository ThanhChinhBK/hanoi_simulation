import { t } from '../i18n';

export const ROAD_CLASS_NAMES: Record<string, string> = {
  motorway: 'motorway',
  trunk: 'trunk road',
  primary: 'primary road',
  secondary: 'secondary road',
  tertiary: 'tertiary road',
  unclassified: 'unclassified road',
  residential: 'residential street',
  living_street: 'living street',
  service: 'service road',
};

/** Human, translated name of an OSM road class. */
export const roadClassName = (cls: string) => t(ROAD_CLASS_NAMES[cls] ?? cls.replace(/_/g, ' '));
