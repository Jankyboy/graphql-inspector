import {NormalizedEnvironment, SchemaPointer, Endpoint} from './config';
import * as probot from 'probot';
import Dataloader from 'dataloader';
import yaml from 'js-yaml';
import axios from 'axios';
import {
  getIntrospectionQuery,
  buildClientSchema,
  printSchema,
  Source,
} from 'graphql';
import {isNil, parseEndpoint, objectFromEntries} from './utils';

function createGetFilesQuery(variableMap: Record<string, string>): string {
  const variables = Object.keys(variableMap)
    .map((name) => `$${name}: String!`)
    .join(', ');

  const files = Object.keys(variableMap)
    .map((name) => {
      return `
      ${name}: object(expression: $${name}) {
        ... on Blob {
          text
        }
      }
    `;
    })
    .join('\n');

  return /* GraphQL */ `
    query GetFile($repo: String!, $owner: String!, ${variables}) {
      repository(name: $repo, owner: $owner) {
        ${files}
      }
    }
  `.replace(/\s+/g, ' ');
}

type FileLoaderConfig = {
  context: probot.Context;
  owner: string;
  repo: string;
};

interface FileLoaderInput {
  path: string;
  ref: string;
  alias: string;
  throwNotFound?: boolean;
  onError?: (error: any) => void;
}

export type FileLoader = (input: FileLoaderInput) => Promise<string | null>;
export type ConfigLoader = () => Promise<object | null | undefined>; // id is the same every time

export function createFileLoader(config: FileLoaderConfig): FileLoader {
  const loader = new Dataloader<FileLoaderInput, string | null, string>(
    async (inputs) => {
      const variablesMap = objectFromEntries(
        inputs.map((input) => [input.alias, `${input.ref}:${input.path}`]),
      );
      const {context, repo, owner} = config;

      const result: any = await context.github.graphql(
        createGetFilesQuery(variablesMap),
        {
          repo,
          owner,
          ...variablesMap,
        },
      );

      return Promise.all(
        inputs.map(async (input) => {
          const alias = input.alias;

          try {
            if (!result) {
              throw new Error(`No result :(`);
            }

            if (result.data) {
              return result.data.repository[alias].text as string;
            }

            return (result as any).repository[alias].text as string;
          } catch (error) {
            const failure = new Error(
              `Failed to load '${input.path}' (ref: ${input.ref})`,
            );

            if (input.throwNotFound === false) {
              if (input.onError) {
                input.onError(failure);
              } else {
                console.error(failure);
              }

              return null;
            }

            throw failure;
          }
        }),
      );
    },
    {
      batch: true,
      maxBatchSize: 5,
      cacheKeyFn(obj) {
        return `${obj.ref} - ${obj.path}`;
      },
    },
  );

  return (input) => loader.load(input);
}

export function createConfigLoader(
  config: FileLoaderConfig & {
    ref: string;
  },
  loadFile: FileLoader,
): ConfigLoader {
  const loader = new Dataloader<string, object | null, string>(
    (ids) => {
      const errors: Error[] = [];
      const onError = (error: any) => {
        errors.push(error);
      };

      return Promise.all(
        ids.map(async (id) => {
          const [yamlConfig, ymlConfig, pkgFile] = await Promise.all([
            loadFile({
              ...config,
              alias: 'yaml',
              path: `.github/${id}.yaml`,
              throwNotFound: false,
              onError,
            }),
            loadFile({
              ...config,
              alias: 'yml',
              path: `.github/${id}.yml`,
              throwNotFound: false,
              onError,
            }),
            loadFile({
              ...config,
              alias: 'pkg',
              path: 'package.json',
              throwNotFound: false,
              onError,
            }),
          ]);

          if (yamlConfig || ymlConfig) {
            return yaml.safeLoad((yamlConfig || ymlConfig)!);
          }

          if (pkgFile) {
            try {
              const pkg = JSON.parse(pkgFile);

              if (pkg[id]) {
                return pkg[id];
              }
            } catch (error) {
              errors.push(error);
            }
          }

          console.error([`Failed to load config:`, ...errors].join('\n'));

          return null;
        }),
      );
    },
    {
      batch: false,
    },
  );

  return () => loader.load('graphql-inspector');
}

export async function printSchemaFromEndpoint(endpoint: Endpoint) {
  const config = parseEndpoint(endpoint);

  const {data: response} = await axios.request({
    method: config.method,
    url: config.url,
    headers: config.headers,
    data: {
      query: getIntrospectionQuery().replace(/\s+/g, ' ').trim(),
    },
  });
  const introspection = response.data;

  return printSchema(
    buildClientSchema(introspection, {
      assumeValid: true,
    }),
  );
}

export async function loadSources({
  config,
  oldPointer,
  newPointer,
  loadFile,
}: {
  config: NormalizedEnvironment;
  oldPointer: SchemaPointer;
  newPointer: SchemaPointer;
  loadFile: FileLoader;
}): Promise<{
  old: Source;
  new: Source;
}> {
  // Here, config.endpoint is defined only if target's branch matches branch of environment
  // otherwise it's empty
  const useEndpoint = !isNil(config.endpoint);

  const [oldFile, newFile] = await Promise.all([
    useEndpoint
      ? printSchemaFromEndpoint(config.endpoint!)
      : loadFile({
          ...oldPointer,
          alias: 'oldSource',
        }),
    loadFile({
      ...newPointer,
      alias: 'newSource',
    }),
  ]);

  return {
    old: new Source(oldFile!),
    new: new Source(newFile!),
  };
}
