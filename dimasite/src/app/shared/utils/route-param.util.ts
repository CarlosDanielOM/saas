import { ActivatedRoute, ActivatedRouteSnapshot, ParamMap } from '@angular/router';

function getParamFromMaps(paramMaps: readonly ParamMap[], key: string): string | null {
  for (let index = paramMaps.length - 1; index >= 0; index -= 1) {
    const value = paramMaps[index]?.get(key);
    if (value) {
      return value;
    }
  }

  return null;
}

export function getRouteParamFromSnapshot(
  route: ActivatedRouteSnapshot,
  key: string
): string | null {
  return getParamFromMaps(route.pathFromRoot.map((currentRoute) => currentRoute.paramMap), key);
}

export function getRouteParam(route: ActivatedRoute, key: string): string | null {
  return getRouteParamFromSnapshot(route.snapshot, key);
}
