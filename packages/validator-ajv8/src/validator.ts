import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import {
  CustomValidator,
  deepEquals,
  ErrorTransformer,
  FormContextType,
  ID_KEY,
  RJSFSchema,
  ROOT_SCHEMA_PREFIX,
  StrictRJSFSchema,
  UiSchema,
  ValidationData,
  ValidatorType,
  withIdRefPrefix,
  hashForSchema,
} from '@rjsf/utils';

import { CustomValidatorOptionsType, Localizer } from './types';
import createAjvInstance from './createAjvInstance';
import processRawValidationErrors, { RawValidationErrorsType } from './processRawValidationErrors';

/** `ValidatorType` implementation that uses the AJV 8 validation mechanism.
 */
export default class AJV8Validator<T = any, S extends StrictRJSFSchema = RJSFSchema, F extends FormContextType = any>
  implements ValidatorType<T, S, F>
{
  /** The AJV instance to use for all validations
   *
   * @private
   */
  ajv: Ajv;

  /** The Localizer function to use for localizing Ajv errors
   *
   * @private
   */
  readonly localizer?: Localizer;

  /** Constructs an `AJV8Validator` instance using the `options`
   *
   * @param options - The `CustomValidatorOptionsType` options that are used to create the AJV instance
   * @param [localizer] - If provided, is used to localize a list of Ajv `ErrorObject`s
   */
  constructor(options: CustomValidatorOptionsType, localizer?: Localizer) {
    const { additionalMetaSchemas, customFormats, ajvOptionsOverrides, ajvFormatOptions, AjvClass } = options;
    this.ajv = createAjvInstance(additionalMetaSchemas, customFormats, ajvOptionsOverrides, ajvFormatOptions, AjvClass);
    this.localizer = localizer;
  }

  /** Resets the internal AJV validator to clear schemas from it. Can be helpful for resetting the validator for tests.
   */
  reset() {
    this.ajv.removeSchema();
  }

  /** Runs the pure validation of the `schema` and `formData` without any of the RJSF functionality. Provided for use
   * by the playground. Returns the `errors` from the validation
   *
   * @param schema - The schema against which to validate the form data   * @param schema
   * @param formData - The form data to validate
   */
  rawValidation<Result = any>(schema: S, formData?: T): RawValidationErrorsType<Result> {
    let compilationError: Error | undefined = undefined;
    let compiledValidator: ValidateFunction | undefined;
    if (schema[ID_KEY]) {
      compiledValidator = this.ajv.getSchema(schema[ID_KEY]);
    }
    try {
      if (compiledValidator === undefined) {
        compiledValidator = this.ajv.compile(schema);
      }
      compiledValidator(formData);
    } catch (err) {
      compilationError = err as Error;
    }

    let errors;
    if (compiledValidator) {
      if (typeof this.localizer === 'function') {
        // Properties need to be enclosed with quotes so that
        // `AJV8Validator#transformRJSFValidationErrors` replaces property names
        // with `title` or `ui:title`. See #4348, #4349, #4387, and #4402.
        (compiledValidator.errors ?? []).forEach((error) => {
          ['missingProperty', 'property'].forEach((key) => {
            if (error.params?.[key]) {
              error.params[key] = `'${error.params[key]}'`;
            }
          });
          if (error.params?.deps) {
            // As `error.params.deps` is the comma+space separated list of missing dependencies, enclose each dependency separately.
            // For example, `A, B` is converted into `'A', 'B'`.
            error.params.deps = error.params.deps
              .split(', ')
              .map((v: string) => `'${v}'`)
              .join(', ');
          }
        });
        this.localizer(compiledValidator.errors);
        // Revert to originals
        (compiledValidator.errors ?? []).forEach((error) => {
          ['missingProperty', 'property'].forEach((key) => {
            if (error.params?.[key]) {
              error.params[key] = error.params[key].slice(1, -1);
            }
          });
          if (error.params?.deps) {
            // Remove surrounding quotes from each missing dependency. For example, `'A', 'B'` is reverted to `A, B`.
            error.params.deps = error.params.deps
              .split(', ')
              .map((v: string) => v.slice(1, -1))
              .join(', ');
          }
        });
      }
      errors = compiledValidator.errors || undefined;

      // Clear errors to prevent persistent errors, see #1104
      compiledValidator.errors = null;
    }

    return {
      errors: errors as unknown as Result[],
      validationError: compilationError,
    };
  }

  /** This function processes the `formData` with an optional user contributed `customValidate` function, which receives
   * the form data and a `errorHandler` function that will be used to add custom validation errors for each field. Also
   * supports a `transformErrors` function that will take the raw AJV validation errors, prior to custom validation and
   * transform them in what ever way it chooses.
   *
   * @param formData - The form data to validate
   * @param schema - The schema against which to validate the form data
   * @param [customValidate] - An optional function that is used to perform custom validation
   * @param [transformErrors] - An optional function that is used to transform errors after AJV validation
   * @param [uiSchema] - An optional uiSchema that is passed to `transformErrors` and `customValidate`
   */
  validateFormData(
    formData: T | undefined,
    schema: S,
    customValidate?: CustomValidator<T, S, F>,
    transformErrors?: ErrorTransformer<T, S, F>,
    uiSchema?: UiSchema<T, S, F>,
  ): ValidationData<T> {
    const rawErrors = this.rawValidation<ErrorObject>(schema, formData);
    return processRawValidationErrors(this, rawErrors, formData, schema, customValidate, transformErrors, uiSchema);
  }

  /**
   * This function checks if a schema needs to be added and if the root schemas don't match it removes the old root schema from the ajv instance and adds the new one.
   * @param rootSchema - The root schema used to provide $ref resolutions
   */
  handleSchemaUpdate(rootSchema: S): void {
    const rootSchemaId = rootSchema[ID_KEY] ?? ROOT_SCHEMA_PREFIX;
    // add the rootSchema ROOT_SCHEMA_PREFIX as id.
    // if schema validator instance doesn't exist, add it.
    // else if the root schemas don't match, we should remove and add the root schema so we don't have to remove and recompile the schema every run.
    if (this.ajv.getSchema(rootSchemaId) === undefined) {
      this.ajv.addSchema(rootSchema, rootSchemaId);
    } else if (!deepEquals(rootSchema, this.ajv.getSchema(rootSchemaId)?.schema)) {
      this.ajv.removeSchema(rootSchemaId);
      this.ajv.addSchema(rootSchema, rootSchemaId);
    }
  }

  /** Validates data against a schema, returning true if the data is valid, or
   * false otherwise. If the schema is invalid, then this function will return
   * false.
   *
   * @param schema - The schema against which to validate the form data
   * @param formData - The form data to validate
   * @param rootSchema - The root schema used to provide $ref resolutions
   */
  isValid(schema: S, formData: T | undefined, rootSchema: S) {
    try {
      this.handleSchemaUpdate(rootSchema);
      // then rewrite the schema ref's to point to the rootSchema
      // this accounts for the case where schema have references to models
      // that lives in the rootSchema but not in the schema in question.
      const schemaWithIdRefPrefix = withIdRefPrefix<S>(schema) as S;
      const schemaId = schemaWithIdRefPrefix[ID_KEY] ?? hashForSchema(schemaWithIdRefPrefix);
      let compiledValidator: ValidateFunction | undefined;
      compiledValidator = this.ajv.getSchema(schemaId);
      if (compiledValidator === undefined) {
        // Add schema by an explicit ID so it can be fetched later
        // Fall back to using compile if necessary
        // https://ajv.js.org/guide/managing-schemas.html#pre-adding-all-schemas-vs-adding-on-demand
        compiledValidator =
          this.ajv.addSchema(schemaWithIdRefPrefix, schemaId).getSchema(schemaId) ||
          this.ajv.compile(schemaWithIdRefPrefix);
      }
      const result = compiledValidator(formData);
      return result as boolean;
    } catch (e) {
      console.warn('Error encountered compiling schema:', e);
      return false;
    }
  }
}
