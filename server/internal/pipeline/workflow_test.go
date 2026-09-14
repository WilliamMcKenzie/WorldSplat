package pipeline

import (
	"context"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"testing"
)

func visual(context.Context, string) error       { return nil }
func splat(context.Context, string) error        { return nil }
func fail(context.Context, string, string) error { return nil }
func TestRenderWorkflow(t *testing.T) {
	for _, bad := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "provider failure"}[bad], func(t *testing.T) {
			var suite testsuite.WorkflowTestSuite
			env := suite.NewTestWorkflowEnvironment()
			env.RegisterActivityWithOptions(visual, activity.RegisterOptions{Name: "RenderVisual"})
			env.RegisterActivityWithOptions(splat, activity.RegisterOptions{Name: "RenderSplat"})
			env.RegisterActivityWithOptions(fail, activity.RegisterOptions{Name: "FailJob"})
			if bad {
				env.OnActivity("RenderVisual", mock.Anything, "job").Return(temporal.NewNonRetryableApplicationError("insufficient provider credits", "ProviderError", nil)).Once()
				env.OnActivity("FailJob", mock.Anything, "job", "RenderVisual: insufficient provider credits").Return(nil).Once()
			} else {
				env.OnActivity("RenderVisual", mock.Anything, "job").Return(nil).Once()
				env.OnActivity("RenderSplat", mock.Anything, "job").Return(nil).Once()
			}
			env.ExecuteWorkflow(Render, "job")
			require.True(t, env.IsWorkflowCompleted())
			if bad {
				require.Error(t, env.GetWorkflowError())
			} else {
				require.NoError(t, env.GetWorkflowError())
				var id string
				require.NoError(t, env.GetWorkflowResult(&id))
				require.Equal(t, "job", id)
			}
			env.AssertExpectations(t)
		})
	}
}
